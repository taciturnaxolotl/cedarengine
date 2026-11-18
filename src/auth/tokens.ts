/** Tokens minted by the engine itself; the plaintext exists only in the create response. */

import { createHash, randomBytes } from "node:crypto";
import { db } from "../db";
import type { Role } from "./roles";

export interface ApiToken {
  id: number;
  label: string;
  role: Role;
  canary: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  /** The indiko sub of whoever minted it for themselves; null for admin-minted tokens. */
  owner: string | null;
  ownerName: string | null;
}

interface Row {
  id: number;
  label: string;
  role: Role;
  canary: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  owner: string | null;
  owner_name: string | null;
  refresh_enc: string | null;
}

/** Prefixed so a leaked one is recognisable in logs and secret scanners. */
export const TOKEN_PREFIX = "ce_";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const toToken = (row: Row): ApiToken => ({
  id: row.id,
  label: row.label,
  role: row.role,
  canary: row.canary === 1,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
  expiresAt: row.expires_at,
  owner: row.owner,
  ownerName: row.owner_name,
});

export interface Personal {
  owner: string;
  ownerName: string;
  refreshSealed: string;
  expiresAt: string;
}

export function createToken(
  label: string,
  role: Role,
  options: { canary?: boolean; personal?: Personal } = {},
): { token: string; record: ApiToken } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const personal = options.personal;
  const row = db()
    .query<Row, (string | number | null)[]>(
      `INSERT INTO api_tokens (label, token_hash, role, canary, created_at, expires_at, owner, owner_name, refresh_enc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      label,
      hashToken(token),
      role,
      options.canary ? 1 : 0,
      new Date().toISOString(),
      personal?.expiresAt ?? null,
      personal?.owner ?? null,
      personal?.ownerName ?? null,
      personal?.refreshSealed ?? null,
    )!;
  return { token, record: toToken(row) };
}

/** Every token, or only one person's. */
export function listTokens(owner?: string): ApiToken[] {
  const rows = owner
    ? db()
        .query<Row, [string]>("SELECT * FROM api_tokens WHERE owner = ? ORDER BY id DESC")
        .all(owner)
    : db().query<Row, []>("SELECT * FROM api_tokens ORDER BY id DESC").all();
  return rows.map(toToken);
}

/** A live token, touched so the admin list can show when it was last used. */
export function findToken(token: string): (ApiToken & { refreshSealed: string | null }) | null {
  const row = db()
    .query<Row, [string, string]>(
      `SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(hashToken(token), new Date().toISOString());
  if (!row) return null;
  db()
    .query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
    .run(new Date().toISOString(), row.id);
  return { ...toToken(row), refreshSealed: row.refresh_enc };
}

/** The sealed refresh token behind a personal token, for revoking it at indiko too. */
export function sealedRefresh(id: number): string | null {
  return (
    db()
      .query<{ refresh_enc: string | null }, [number]>(
        "SELECT refresh_enc FROM api_tokens WHERE id = ?",
      )
      .get(id)?.refresh_enc ?? null
  );
}

/** Indiko rotates refresh tokens on every use; the new one must be saved before it is used. */
export function storeRefresh(id: number, sealed: string): void {
  db().query("UPDATE api_tokens SET refresh_enc = ? WHERE id = ?").run(sealed, id);
}

/** Revoke a token; with `owner`, only if it is theirs. */
export function revokeToken(id: number, owner?: string): boolean {
  const now = new Date().toISOString();
  const result = owner
    ? db()
        .query(
          "UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND owner = ? AND revoked_at IS NULL",
        )
        .run(now, id, owner)
    : db()
        .query("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(now, id);
  return result.changes > 0;
}

export const tokenCount = (): number =>
  db()
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at IS NULL")
    .get()!.n;
