/**
 * Tokens issued by indiko, checked by asking indiko.
 *
 * Indiko's access tokens are opaque, so each one is introspected, presenting
 * the token itself as the credential (no client secret to keep). The answer
 * is trusted only if it was minted for this engine: `aud` must be exactly our
 * public URL, or any indiko login for any other app would open the directory.
 * The role is the one indiko reports for our resource.
 */

import { config } from "../config";
import { hashToken } from "./tokens";

export interface IndikoGrant {
  sub: string;
  username: string;
  clientId: string;
  role: string | undefined;
  expiresAt: number;
}

/** Long enough to spare indiko a call per request, short enough that a revocation lands in a minute. */
const CACHE_MS = 60_000;
const NEGATIVE_CACHE_MS = 10_000;
/** Why a token was not accepted, worded for the person holding it. */
export interface Refusal {
  refused: string;
}

const cache = new Map<string, { result: IndikoGrant | Refusal; until: number }>();

export function forgetIndikoCache(): void {
  cache.clear();
}

export async function introspect(token: string): Promise<IndikoGrant | null> {
  const result = await inspect(token);
  return "refused" in result ? null : result;
}

/** Introspect, keeping the reason when indiko's answer does not let the token in. */
export async function inspect(token: string): Promise<IndikoGrant | Refusal> {
  const base = config.indikoUrl;
  if (!base) return { refused: "unknown token" };

  const key = hashToken(token);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.until > now) return hit.result;

  const result = await ask(base, token);
  const until =
    "refused" in result
      ? now + NEGATIVE_CACHE_MS
      : Math.min(now + CACHE_MS, result.expiresAt * 1000);
  cache.set(key, { result, until });
  return result;
}

async function ask(base: string, token: string): Promise<IndikoGrant | Refusal> {
  let body: Record<string, unknown>;
  try {
    const response = await fetch(`${base}/auth/token/introspect`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401) return { refused: "expired or unknown token" };
    if (!response.ok)
      return { refused: `indiko answered ${response.status} when checking the token` };
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return { refused: "indiko could not be reached to check the token" };
  }

  if (body.active !== true) return { refused: "expired or revoked sign-in" };
  if (body.aud !== config.publicUrl) {
    return {
      refused: body.aud
        ? `this sign-in is for ${String(body.aud)}, not ${config.publicUrl}`
        : `this sign-in was not requested for ${config.publicUrl}`,
    };
  }
  if (typeof body.sub !== "string" || typeof body.client_id !== "string") {
    return { refused: "indiko's answer was missing who the token belongs to" };
  }
  return {
    sub: body.sub,
    username: typeof body.username === "string" ? body.username : body.sub,
    clientId: body.client_id,
    role: typeof body.role === "string" ? body.role : undefined,
    expiresAt: typeof body.exp === "number" ? body.exp : Math.floor(Date.now() / 1000) + 60,
  };
}
