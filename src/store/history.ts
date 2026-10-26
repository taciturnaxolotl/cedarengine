/**
 * The longitudinal half of the engine.
 *
 * Every upstream source here is a snapshot API: ask it today and it tells you
 * about today. Who moved dorms over the summer, which class actually
 * graduated, whether someone dropped a course three weeks in — none of that
 * exists upstream, and all of it is recoverable if you write down what changed
 * each time you look. So sweeps are logged, diffs are logged, and the current
 * row is treated as the latest frame rather than the truth.
 *
 * "Vanished" is the one claim that needs care. A person missing from a partial
 * sweep is not gone, they are unlooked-at. Only a run that claims to have seen
 * everybody can retire a row, which is what `complete` on a sweep records.
 */

import { db } from "../db";

export type SweepKind = "directory" | "booklists" | "catalog" | "book" | "campus";
export type SweepSource = "cli" | "extension" | "import";

export interface Sweep {
  id: number;
  kind: SweepKind;
  source: SweepSource;
  startedAt: string;
  finishedAt: string | null;
  complete: number;
  seen: number;
  added: number;
  changed: number;
  vanished: number;
  note: string | null;
}

/**
 * Open a sweep. The id it returns is what finishes it.
 *
 * A browser extension can wander off mid-sweep — the session dies, the tab
 * closes, the token expires — and leave a sweep open forever. Rather than trust
 * every client to close what it starts, a new sweep of a kind reaps any older
 * one of that kind still running: whatever it was doing, it has been abandoned,
 * and leaving it "running" only clutters the record and skews coverage.
 */
export function startSweep(kind: SweepKind, source: SweepSource, note?: string): number {
  db()
    .query(
      `UPDATE sweeps SET finished_at = ?, complete = 0,
         note = COALESCE(note || ' · ', '') || 'superseded'
       WHERE kind = ? AND finished_at IS NULL`,
    )
    .run(new Date().toISOString(), kind);
  const row = db()
    .query<{ id: number }, [string, string, string, string | null]>(
      `INSERT INTO sweeps (kind, source, started_at, note) VALUES (?, ?, ?, ?) RETURNING id`,
    )
    .get(kind, source, new Date().toISOString(), note ?? null);
  return row?.id ?? 0;
}

export interface SweepTally {
  seen?: number;
  added?: number;
  changed?: number;
  vanished?: number;
  complete?: boolean;
  note?: string;
}

/**
 * Add to a sweep's running totals.
 *
 * Counters accumulate rather than being set, because a sweep driven by the
 * extension arrives one batch at a time and each batch only knows about
 * itself.
 */
export function bumpSweep(id: number, tally: SweepTally): void {
  db()
    .query(
      `UPDATE sweeps SET seen = seen + ?, added = added + ?, changed = changed + ?,
         vanished = vanished + ?
       WHERE id = ?`,
    )
    .run(tally.seen ?? 0, tally.added ?? 0, tally.changed ?? 0, tally.vanished ?? 0, id);
}

export function finishSweep(id: number, tally: SweepTally = {}): void {
  bumpSweep(id, tally);
  db()
    .query("UPDATE sweeps SET finished_at = ?, complete = ?, note = COALESCE(?, note) WHERE id = ?")
    .run(new Date().toISOString(), tally.complete ? 1 : 0, tally.note ?? null, id);
}

export const recentSweeps = (limit = 20): Sweep[] =>
  db()
    .query<Sweep, [number]>(
      `SELECT id, kind, source, started_at AS startedAt, finished_at AS finishedAt,
              complete, seen, added, changed, vanished, note
       FROM sweeps ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);

export const lastSweep = (kind: SweepKind): Sweep | null =>
  db()
    .query<Sweep, [string]>(
      `SELECT id, kind, source, started_at AS startedAt, finished_at AS finishedAt,
              complete, seen, added, changed, vanished, note
       FROM sweeps WHERE kind = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(kind);

export interface PersonEvent {
  seq: number;
  studentId: string;
  at: string;
  kind: "appeared" | "changed" | "vanished" | "returned";
  field: string | null;
  was: string | null;
  now: string | null;
}

const PERSON_EVENT_SELECT = `SELECT seq, student_id AS studentId, at, kind, field, was, now
  FROM person_events`;

export const personTimeline = (studentId: string, limit = 200): PersonEvent[] =>
  db()
    .query<PersonEvent, [string, number]>(
      `${PERSON_EVENT_SELECT} WHERE student_id = ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(studentId, limit);

export interface EventQuery {
  kind?: string;
  field?: string;
  since?: string;
  limit?: number;
}

export function personEvents(query: EventQuery = {}): PersonEvent[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (query.kind) {
    where.push("kind = ?");
    args.push(query.kind);
  }
  if (query.field) {
    where.push("field = ?");
    args.push(query.field);
  }
  if (query.since) {
    where.push("at >= ?");
    args.push(query.since);
  }
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
  return db()
    .query<PersonEvent, any[]>(
      `${PERSON_EVENT_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(...args, limit);
}

export interface BooklistEvent {
  seq: number;
  studentId: string;
  term: string;
  at: string;
  kind: "first" | "changed";
  added: string[];
  removed: string[];
}

const hydrateBooklistEvent = (row: {
  seq: number;
  studentId: string;
  term: string;
  at: string;
  kind: "first" | "changed";
  added: string;
  removed: string;
}): BooklistEvent => ({
  ...row,
  added: JSON.parse(row.added) as string[],
  removed: JSON.parse(row.removed) as string[],
});

export const booklistTimeline = (studentId: string, limit = 100): BooklistEvent[] =>
  db()
    .query<any, [string, number]>(
      `SELECT seq, student_id AS studentId, term, at, kind, added, removed
       FROM booklist_events WHERE student_id = ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(studentId, limit)
    .map(hydrateBooklistEvent);

/** Schedule churn across a term: what got added and dropped, and by how many. */
export const termChurn = (
  term: string,
): { added: number; removed: number; students: number; changes: number } => {
  const rows = db()
    .query<{ added: string; removed: string; studentId: string }, [string]>(
      `SELECT added, removed, student_id AS studentId FROM booklist_events
       WHERE term = ? AND kind = 'changed'`,
    )
    .all(term);

  const students = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    students.add(row.studentId);
    added += (JSON.parse(row.added) as string[]).length;
    removed += (JSON.parse(row.removed) as string[]).length;
  }
  return { added, removed, students: students.size, changes: rows.length };
};

/** Arrivals and departures per month, which is the shape of an academic year. */
export const populationOverTime = (): { month: string; appeared: number; vanished: number }[] =>
  db()
    .query<{ month: string; appeared: number; vanished: number }, []>(
      `SELECT substr(at, 1, 7) AS month,
              SUM(kind = 'appeared') AS appeared,
              SUM(kind = 'vanished') AS vanished
       FROM person_events WHERE kind IN ('appeared', 'vanished')
       GROUP BY month ORDER BY month`,
    )
    .all();
