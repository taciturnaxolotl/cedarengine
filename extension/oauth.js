/**
 * Signing in to the engine with indiko instead of a pasted token.
 *
 * The engine publishes where to sign in and this extension's client id at
 * /.well-known/oauth-protected-resource. Chrome runs the authorization page
 * in its own window (launchWebAuthFlow) and hands back the redirect to
 * https://<extension-id>.chromiumapp.org/, which the engine lists in this
 * client's metadata. Tokens are refreshed here as they expire; indiko
 * rotates the refresh token on every use, so the new one is always stored.
 */

const KEY = "oauth";
/** Refresh this long before expiry, so a sync never starts on a token about to lapse. */
const SKEW_MS = 60_000;

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function discover(engineBase) {
  const base = engineBase.replace(/\/$/, "");
  const prm = await fetch(`${base}/.well-known/oauth-protected-resource`).then((r) => {
    if (!r.ok) throw new Error("this engine has no indiko sign-in configured");
    return r.json();
  });
  const issuer = prm.authorization_servers[0];
  const meta = await fetch(`${issuer}/.well-known/oauth-authorization-server`).then((r) =>
    r.json(),
  );
  return {
    issuer,
    resource: prm.resource,
    clientId: prm.clients.extension,
    authorize: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
  };
}

function store(grant, data) {
  return chrome.storage.local.set({
    [KEY]: {
      ...grant,
      access: data.access_token,
      refresh: data.refresh_token ?? grant.refresh ?? null,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      me: data.me ?? grant.me ?? null,
    },
  });
}

/** Interactive sign-in. Needs host permission for indiko, which the popup requests first. */
export async function signIn(engineBase) {
  const cfg = await discover(engineBase);
  const redirectUri = chrome.identity.getRedirectURL();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );

  const url = new URL(cfg.authorize);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: "profile offline_access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: cfg.resource,
  })) {
    url.searchParams.set(k, v);
  }

  const returned = new URL(
    await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true }),
  );
  const error = returned.searchParams.get("error");
  if (error) throw new Error(returned.searchParams.get("error_description") ?? error);
  if (returned.searchParams.get("state") !== state) throw new Error("sign-in state did not match");

  const response = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: returned.searchParams.get("code"),
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description ?? "indiko refused the sign-in");
  await store({ clientId: cfg.clientId, tokenEndpoint: cfg.tokenEndpoint }, data);
  return { me: data.me ?? null };
}

export async function signOut() {
  await chrome.storage.local.remove(KEY);
}

async function refresh(grant) {
  if (!grant.refresh) return null;
  const response = await fetch(grant.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: grant.refresh,
      client_id: grant.clientId,
    }),
  });
  if (!response.ok) {
    await signOut();
    return null;
  }
  await store(grant, await response.json());
  return (await chrome.storage.local.get(KEY))[KEY].access;
}

/** The indiko access token to send, refreshed if needed; null when not signed in. */
export async function oauthBearer({ force = false } = {}) {
  const grant = (await chrome.storage.local.get(KEY))[KEY];
  if (!grant) return null;
  if (!force && grant.expiresAt - SKEW_MS > Date.now()) return grant.access;
  return refresh(grant);
}

export async function oauthState() {
  const grant = (await chrome.storage.local.get(KEY))[KEY];
  return grant ? { signedIn: true, me: grant.me } : { signedIn: false };
}
