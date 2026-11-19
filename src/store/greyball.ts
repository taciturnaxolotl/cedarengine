/**
 * The greyball list: callers whose answers are invented rather than true.
 *
 * Level 1 gives that caller a plausible timetable instead of the real one for
 * any person they look up; everything else they see stays accurate. Level 2
 * is the canary treatment, invented people everywhere. The key is the actor
 * the pipeline authenticates: "env", "token:<id>" or "indiko:<sub>", the same
 * string the audit log uses, so a person's indiko sign-ins and a script's
 * minted token can be greyballed apart from each other.
 */

import { listTokens } from "../auth/tokens";
import { config } from "../config";
import { db } from "../db";

export interface Greyball {
  actor: string;
  level: 1 | 2;
  note: string | null;
  updatedAt: string;
}

export function listGreyball(): Greyball[] {
  return db()
    .query<Greyball, []>(
      `SELECT actor, level, note, updated_at AS updatedAt
       FROM greyball ORDER BY level DESC, updated_at DESC`,
    )
    .all();
}

/** Whether anybody is greyballed at all: the cheap question the pipeline asks on every request. */
export function anyGreyball(): boolean {
  return !!db().query<{ n: number }, []>("SELECT 1 AS n FROM greyball LIMIT 1").get();
}

/** Every level in one read, so a request needs one query rather than one per route. */
export function greyballLevels(): Map<string, 1 | 2> {
  return new Map(listGreyball().map((row) => [row.actor, row.level]));
}

/** The admin page's view of the list, with a name wherever we can put one to the actor. */
export function greyballRoster(): (Greyball & { name: string })[] {
  const tokens = new Map(listTokens().map((token) => [token.id, token.label]));
  return listGreyball().map((row) => {
    const tokenId = row.actor.startsWith("token:")
      ? Number(row.actor.slice("token:".length))
      : null;
    return {
      ...row,
      name:
        tokenId !== null
          ? (tokens.get(tokenId) ?? `token ${tokenId}`)
          : row.actor.startsWith("indiko:")
            ? `${row.actor.split("/u/").pop()} (${config.indikoUrl ?? "indiko"})`
            : "BEARER_TOKEN",
    };
  });
}

export function setGreyball(actor: string, level: 1 | 2, note: string | null): void {
  db()
    .query(
      `INSERT INTO greyball (actor, level, note, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (actor) DO UPDATE SET
         level = excluded.level, note = excluded.note, updated_at = excluded.updated_at`,
    )
    .run(actor, level, note, new Date().toISOString());
}

export function removeGreyball(actor: string): boolean {
  return db().query("DELETE FROM greyball WHERE actor = ?").run(actor).changes > 0;
}
