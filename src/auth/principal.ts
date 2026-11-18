/** Turning a request into the one thing every check downstream needs: who is asking, and as what. */

import { timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { personalRole } from "./grants";
import { inspect } from "./indiko";
import { isRole, ROLES, type Role } from "./roles";
import { findToken, TOKEN_PREFIX } from "./tokens";

export interface Principal {
  /** Stable id for the audit log: env, token:<id> or indiko:<sub>. */
  actor: string;
  name: string;
  role: Role;
  /** The OAuth client the person signed in through, for indiko grants. */
  client: string | null;
  canary: boolean;
  /** The indiko sub behind this request: the signed-in person, or a personal token's owner. */
  owner: string | null;
}

/** The token from `Authorization`, or `?token=` on routes an `<img>` must load. */
export function presentedToken(request: Request, allowQuery: boolean): string {
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  if (given || !allowQuery) return given;
  return new URL(request.url).searchParams.get("token") ?? "";
}

const sameSecret = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Who is asking, or a sentence saying why they were not let in. */
export async function authenticate(token: string): Promise<Principal | string> {
  if (!token) return "sign in, or send a bearer token";

  const envToken = config.bearerToken;
  if (envToken && sameSecret(token, envToken)) {
    return {
      actor: "env",
      name: "BEARER_TOKEN",
      role: "admin",
      client: null,
      canary: false,
      owner: null,
    };
  }

  if (token.startsWith(TOKEN_PREFIX)) {
    const minted = findToken(token);
    if (!minted) return "this token is revoked, expired or unknown";
    if (!minted.owner) {
      return {
        actor: `token:${minted.id}`,
        name: minted.label,
        role: minted.role,
        client: null,
        canary: minted.canary,
        owner: null,
      };
    }
    // A personal token answers to its owner's live indiko role.
    const tokensClient = `${config.publicUrl}/oauth/tokens.json`;
    const role = await personalRole(
      { id: minted.id, owner: minted.owner, role: minted.role },
      tokensClient,
    );
    return role
      ? {
          actor: `token:${minted.id}`,
          name: `${minted.label} (${minted.ownerName ?? minted.owner})`,
          role,
          client: tokensClient,
          canary: false,
          owner: minted.owner,
        }
      : "this personal token's owner no longer holds a role that allows it";
  }

  const grant = await inspect(token);
  if ("refused" in grant) return grant.refused;
  if (!grant.role) {
    return `signed in as ${grant.username}, but indiko reports no role for you on ${config.publicUrl}; an admin assigns one in indiko under admin → resources`;
  }
  if (!isRole(grant.role)) {
    return `indiko reports the role "${grant.role}", which cedarengine does not have (it knows ${Object.keys(ROLES).join(", ")})`;
  }
  return {
    actor: `indiko:${grant.sub}`,
    name: grant.username,
    role: grant.role,
    client: grant.clientId,
    canary: false,
    owner: grant.sub,
  };
}
