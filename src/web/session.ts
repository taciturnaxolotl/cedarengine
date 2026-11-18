/**
 * Signing in to the engine from a browser, shared by every page.
 *
 * There is one session, kept in localStorage: either an indiko sign-in (an
 * hour-long access token through the `web` client; indiko remembers consent,
 * so renewing is a click) or a pasted token for scripts and BEARER_TOKEN.
 * /account is where signing in happens; other pages send people there with
 * ?next= and pick the session up when they come back.
 */

const STORE = "cedarengine.session";
const LEGACY = "cedarengine.token";
const PENDING = "cedarengine.pending";

export interface Session {
  token: string;
  via: "indiko" | "token";
  /** Epoch ms; null for pasted tokens, which the server judges. */
  expiresAt: number | null;
}

interface SignIn {
  resource: string;
  issuer: string;
  authorize: string;
  token: string;
  clients: Record<string, string>;
}

export type Pending =
  | { kind: "session"; next: string }
  | { kind: "mint"; label: string; role: string; days: number };

export class SignedOut extends Error {}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Only same-origin paths, so ?next= cannot bounce someone off-site. */
export const safeNext = (value: string | null) =>
  value?.startsWith("/") && !value.startsWith("//") ? value : "/";

export function session(): Session | null {
  const legacy = localStorage.getItem(LEGACY);
  if (legacy) {
    localStorage.removeItem(LEGACY);
    if (!localStorage.getItem(STORE)) usePastedToken(legacy);
  }
  const stored = JSON.parse(localStorage.getItem(STORE) ?? "null") as Session | null;
  if (stored?.expiresAt && stored.expiresAt < Date.now()) {
    localStorage.removeItem(STORE);
    return null;
  }
  return stored;
}

export function usePastedToken(token: string): void {
  localStorage.setItem(STORE, JSON.stringify({ token, via: "token", expiresAt: null }));
}

export function signOut(): void {
  localStorage.removeItem(STORE);
}

/** Send someone to /account to sign in, coming back to `next`. */
export function requireSignIn(next = location.pathname + location.hash): never {
  location.assign(`/account?next=${encodeURIComponent(next)}`);
  throw new SignedOut("signing in");
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const current = session();
  if (!current) throw new SignedOut("signed out");
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${current.token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (response.status === 401) {
    signOut();
    throw new SignedOut(data.error ?? "signed out");
  }
  if (!response.ok) throw new Error(data.error ?? `request failed (${response.status})`);
  return data;
}

let discovered: Promise<SignIn | null> | undefined;

/** Where to sign in, from the engine's protected-resource document; null when indiko is off. */
export function signInConfig(): Promise<SignIn | null> {
  discovered ??= (async () => {
    const res = await fetch("/.well-known/oauth-protected-resource");
    if (!res.ok) return null;
    const prm = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      clients: Record<string, string>;
    };
    const issuer = prm.authorization_servers[0]!;
    const meta = (await fetch(`${issuer}/.well-known/oauth-authorization-server`).then((r) =>
      r.json(),
    )) as { authorization_endpoint: string; token_endpoint: string };
    return {
      resource: prm.resource,
      issuer,
      authorize: meta.authorization_endpoint,
      token: meta.token_endpoint,
      clients: prm.clients,
    };
  })().catch(() => null);
  return discovered;
}

const redirectUri = (cfg: SignIn) => `${cfg.resource}/account`;

/** Start an indiko sign-in: `session` for this browser, `mint` for a personal token's own sign-in. */
export async function startSignIn(pending: Pending): Promise<void> {
  const cfg = await signInConfig();
  if (!cfg) throw new Error("indiko sign-in is not configured on this engine");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  sessionStorage.setItem(PENDING, JSON.stringify({ ...pending, verifier, state }));

  const url = new URL(cfg.authorize);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: pending.kind === "mint" ? cfg.clients.tokens! : cfg.clients.web!,
    redirect_uri: redirectUri(cfg),
    // A personal token outlives the page, so its sign-in must be renewable.
    scope: pending.kind === "mint" ? "profile offline_access" : "profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: cfg.resource,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  location.assign(url);
}

export type Returned =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "session"; next: string }
  | { kind: "mint"; code: string; verifier: string; label: string; role: string; days: number };

/** If this page load is indiko sending someone back, finish what they started. */
export async function finishSignIn(): Promise<Returned> {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const error = params.get("error");
  if (!code && !error) return { kind: "none" };
  history.replaceState(null, "", "/account");

  const pending = JSON.parse(sessionStorage.getItem(PENDING) ?? "null") as
    | (Pending & { verifier: string; state: string })
    | null;
  sessionStorage.removeItem(PENDING);
  if (error) return { kind: "error", message: params.get("error_description") ?? error };
  const cfg = await signInConfig();
  if (!pending || !cfg || pending.state !== params.get("state")) {
    return { kind: "error", message: "that sign-in did not match one started here; try again" };
  }
  if (params.get("iss") && params.get("iss") !== cfg.issuer) {
    return { kind: "error", message: "the sign-in came back from the wrong issuer" };
  }

  // A personal token's code goes to the engine, which keeps its refresh token.
  if (pending.kind === "mint") {
    const { label, role, days, verifier } = pending;
    return { kind: "mint", code: code!, verifier, label, role, days };
  }

  const res = await fetch(cfg.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      client_id: cfg.clients.web!,
      redirect_uri: redirectUri(cfg),
      code_verifier: pending.verifier,
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    return { kind: "error", message: data.error_description ?? "indiko refused the sign-in" };
  }
  const session: Session = {
    token: data.access_token,
    via: "indiko",
    expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
  };
  localStorage.setItem(STORE, JSON.stringify(session));
  return { kind: "session", next: safeNext(pending.next) };
}
