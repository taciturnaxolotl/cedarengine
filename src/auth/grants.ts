/**
 * The indiko sign-ins behind personal tokens.
 *
 * A personal token is a `ce_` token its owner can paste into curl, but every
 * use is answered with their live indiko role: the engine keeps that sign-in's
 * refresh token (sealed with SECRET_KEY), renews the access token as it lapses
 * and introspects it. Removing the role, revoking the app in indiko or
 * suspending the account cuts the token off within the introspection cache.
 * A sign-in unused for indiko's refresh lifetime simply dies.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config";
import { introspect } from "./indiko";
import { roleWithin } from "./masks";
import { isRole, type Role } from "./roles";
import { revokeToken, sealedRefresh, storeRefresh } from "./tokens";

export const personalTokensEnabled = () => !!config.indikoUrl && !!config.secretKey;

const key = () =>
  createHash("sha256")
    .update(config.secretKey ?? "")
    .digest();

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
}

export function unseal(sealed: string): string {
  const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(body!), decipher.final()]).toString("utf8");
}

interface Endpoints {
  token: string;
  revocation: string | undefined;
}

let endpoints: Promise<Endpoints> | undefined;

/** Indiko's token and revocation endpoints, from its metadata, fetched once. */
function indikoEndpoints(): Promise<Endpoints> {
  endpoints ??= fetch(`${config.indikoUrl}/.well-known/oauth-authorization-server`)
    .then((r) => r.json() as Promise<{ token_endpoint: string; revocation_endpoint?: string }>)
    .then((meta) => ({ token: meta.token_endpoint, revocation: meta.revocation_endpoint }))
    .catch((error) => {
      endpoints = undefined;
      throw error;
    });
  return endpoints;
}

interface TokenReply {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function tokenRequest(form: Record<string, string>): Promise<TokenReply | "invalid" | null> {
  try {
    const response = await fetch((await indikoEndpoints()).token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 400 || response.status === 401) return "invalid";
    return response.ok ? ((await response.json()) as TokenReply) : null;
  } catch {
    return null;
  }
}

/** Access tokens live in memory only; a restart costs one refresh per personal token. */
const access = new Map<number, { token: string; until: number }>();
const renewing = new Map<number, Promise<string | null>>();

export function forgetGrants(): void {
  access.clear();
  renewing.clear();
  endpoints = undefined;
}

/**
 * Exchange the code from a "new token" sign-in. The browser never sees the
 * refresh token: it hands the engine the code and its PKCE verifier.
 */
export async function exchangeCode(
  clientId: string,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<{ access: string; refresh: string; expiresIn: number } | string> {
  const reply = await tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (reply === null) return "indiko did not answer";
  if (reply === "invalid") return "indiko refused the sign-in code; try again";
  if (!reply.refresh_token)
    return "the sign-in carries no refresh token, so it cannot back a token";
  return {
    access: reply.access_token,
    refresh: reply.refresh_token,
    expiresIn: reply.expires_in ?? 3600,
  };
}

export function remember(id: number, token: string, expiresIn: number): void {
  access.set(id, { token, until: Date.now() + (expiresIn - 60) * 1000 });
}

/** One renewal at a time per token: reusing a rotated refresh token makes indiko revoke the lot. */
function renew(id: number, clientId: string): Promise<string | null> {
  const running = renewing.get(id);
  if (running) return running;
  const attempt = (async () => {
    const sealed = sealedRefresh(id);
    if (!sealed) return null;
    const reply = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: unseal(sealed),
      client_id: clientId,
    });
    if (reply === "invalid") {
      // The sign-in is gone for good (expired, revoked, or the user suspended).
      revokeToken(id);
      access.delete(id);
      return null;
    }
    if (reply === null) return null;
    if (reply.refresh_token) storeRefresh(id, seal(reply.refresh_token));
    remember(id, reply.access_token, reply.expires_in ?? 3600);
    return reply.access_token;
  })().finally(() => renewing.delete(id));
  renewing.set(id, attempt);
  return attempt;
}

/** The owner's role right now, as indiko reports it for this engine and this client; null if none. */
async function currentRole(id: number, owner: string, clientId: string): Promise<Role | null> {
  const check = async (token: string) => {
    const grant = await introspect(token);
    return grant && grant.sub === owner && grant.clientId === clientId && isRole(grant.role)
      ? grant.role
      : null;
  };
  const cached = access.get(id);
  if (cached && cached.until > Date.now()) {
    const role = await check(cached.token);
    if (role) return role;
  }
  const fresh = await renew(id, clientId);
  return fresh ? check(fresh) : null;
}

/**
 * The role a personal token acts with: what it was minted as, unless the
 * owner's live role has since narrowed below that, in which case the live
 * role. Null (refused) when the owner has no role, or roles diverged.
 */
export async function personalRole(
  token: { id: number; owner: string; role: Role },
  clientId: string,
): Promise<Role | null> {
  const live = await currentRole(token.id, token.owner, clientId);
  if (!live) return null;
  if (roleWithin(token.role, live)) return token.role;
  if (roleWithin(live, token.role)) return live;
  return null;
}

/** Best effort: tell indiko the sign-in behind a revoked token is finished. */
export async function revokeAtIndiko(sealed: string | null): Promise<void> {
  if (!sealed || !config.indikoUrl) return;
  try {
    const { revocation } = await indikoEndpoints();
    if (!revocation) return;
    await fetch(revocation, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: unseal(sealed), token_type_hint: "refresh_token" }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // The token is already dead here; indiko's copy expires on its own.
  }
}
