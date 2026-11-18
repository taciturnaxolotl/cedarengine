/** The audit log: one row per authenticated request, full path included. */

import { config } from "../config";
import { db } from "../db";
import type { Principal } from "./principal";

export interface AuditEntry {
  principal: Principal;
  method: string;
  endpoint: string;
  path: string;
  status: number;
  ip: string | null;
  userAgent: string | null;
}

export function audit(entry: AuditEntry): void {
  db()
    .query(
      `INSERT INTO audit_log (at, actor, actor_name, role, client, method, endpoint, path, status, ip, user_agent, canary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      entry.principal.actor,
      entry.principal.name,
      entry.principal.role,
      entry.principal.client,
      entry.method,
      entry.endpoint,
      entry.path,
      entry.status,
      entry.ip,
      entry.userAgent,
      entry.principal.canary ? 1 : 0,
    );
}

export interface AuditQuery {
  actor?: string;
  endpoint?: string;
  /** Substring of the path, e.g. a person's id. */
  path?: string;
  since?: string;
  canary?: boolean;
  limit?: number;
  offset?: number;
}

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  actorName: string;
  role: string;
  client: string | null;
  method: string;
  endpoint: string;
  path: string;
  status: number;
  ip: string | null;
  userAgent: string | null;
  canary: boolean;
}

export function auditLog(query: AuditQuery = {}): { total: number; rows: AuditRow[] } {
  const filters: [clause: string, value: string | undefined][] = [
    ["actor = ?", query.actor],
    ["endpoint = ?", query.endpoint],
    ["instr(path, ?) > 0", query.path],
    ["at >= ?", query.since],
  ];
  const active = filters.filter((filter): filter is [string, string] => !!filter[1]);
  const where = active.map(([clause]) => clause);
  const params: (string | number)[] = active.map(([, value]) => value);
  if (query.canary) where.push("canary = 1");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);

  const total = db()
    .query<{ n: number }, (string | number)[]>(`SELECT COUNT(*) AS n FROM audit_log ${clause}`)
    .get(...params)!.n;
  const rows = db()
    .query<Record<string, string | number | null>, (string | number)[]>(
      `SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, query.offset ?? 0)
    .map((row) => ({
      id: row.id as number,
      at: row.at as string,
      actor: row.actor as string,
      actorName: row.actor_name as string,
      role: row.role as string,
      client: row.client as string | null,
      method: row.method as string,
      endpoint: row.endpoint as string,
      path: row.path as string,
      status: row.status as number,
      ip: row.ip as string | null,
      userAgent: row.user_agent as string | null,
      canary: row.canary === 1,
    }));
  return { total, rows };
}

export function trimAudit(days = config.auditRetentionDays): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return db().query("DELETE FROM audit_log WHERE at < ?").run(cutoff).changes;
}
