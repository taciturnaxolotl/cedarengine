/**
 * Facts: everything true about a person that the directory does not say.
 *
 * The directory knows where somebody sleeps and what class they are in. It has
 * never heard of their GroupMe account, the personality test they took, or the
 * photograph somebody posted of them. Those arrive from elsewhere, one system
 * at a time, and they have to survive the sweep that rewrites `people` every
 * time it runs.
 *
 * Two rules do most of the work here. Nothing is ever deleted — a retraction is
 * another row — so a bad import is undone by looking one row further back
 * rather than restored from a backup. And two sources may disagree freely: the
 * newest row wins *per source*, so a hand identification and a scraped one sit
 * side by side and the caller decides which it believes.
 */

import { db } from "../db";

export interface Fact {
  key: string;
  slot: string;
  value: unknown;
  source: string;
  at: string;
}

interface FactRow {
  seq: number;
  student_id: string;
  key: string;
  slot: string;
  value: string;
  json: number;
  source: string;
  at: string;
  retracted?: number;
}

/**
 * How a value goes in and comes back out.
 *
 * A string stays a string, so `groupme.id` is `12345` in the column and the
 * reverse lookup is an index seek on a literal. Anything with structure
 * becomes JSON and is flagged, because guessing afterwards is how `"12345"`
 * and `12345` become the same fact.
 */
const encode = (value: unknown): { value: string; json: number } =>
  typeof value === "string"
    ? { value, json: 0 }
    : typeof value === "number" || typeof value === "boolean"
      ? { value: String(value), json: 0 }
      : { value: JSON.stringify(value), json: 1 };

const decode = (row: FactRow): unknown => (row.json ? JSON.parse(row.value) : row.value);

const toFact = (row: FactRow): Fact => ({
  key: row.key,
  slot: row.slot,
  value: decode(row),
  source: row.source,
  at: row.at,
});

export interface Assertion {
  key: string;
  value: unknown;
  /** Only for a fact somebody has several of. A photograph's url does nicely. */
  slot?: string;
  source: string;
}

/**
 * Write facts down. Always an append, never an update.
 *
 * Re-asserting exactly what is already the newest value still writes a row.
 * That looks wasteful and is not: "we checked again on Tuesday and it still
 * said INTJ" is a different statement from silence, and the log is the only
 * place it can be made.
 */
export function assertFacts(studentId: string, facts: Assertion[], at = new Date().toISOString()) {
  if (!facts.length) return 0;
  const insert = db().query(
    `INSERT INTO person_facts (student_id, key, slot, value, json, source, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const write = db().transaction((rows: Assertion[]) => {
    for (const fact of rows) {
      const { value, json } = encode(fact.value);
      insert.run(studentId, fact.key, fact.slot ?? "", value, json, fact.source, at);
    }
    return rows.length;
  });
  return write(facts);
}

/**
 * Tombstone a fact, by writing that it is no longer so.
 *
 * The value is carried across from whatever is being retracted rather than
 * left empty, so the log still reads as a sentence: this was the claim, and
 * this is the moment it stopped being made.
 */
export function retractFact(
  studentId: string,
  key: string,
  source: string,
  slot = "",
  at = new Date().toISOString(),
): boolean {
  const current = db()
    .query<FactRow, [string, string, string, string]>(
      `SELECT * FROM current_facts
       WHERE student_id = ? AND key = ? AND source = ? AND slot = ?`,
    )
    .get(studentId, key, source, slot);
  if (!current) return false;

  db()
    .query(
      `INSERT INTO person_facts (student_id, key, slot, value, json, source, at, retracted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(studentId, key, slot, current.value, current.json, source, at);
  return true;
}

/** Everything currently asserted about one person. */
export function factsFor(studentId: string): Fact[] {
  return db()
    .query<FactRow, [string]>(
      `SELECT * FROM current_facts WHERE student_id = ? ORDER BY key, source, slot`,
    )
    .all(studentId)
    .map(toFact);
}

/** The whole log for one person, newest first, tombstones and all. */
export function factHistory(studentId: string, limit = 200): (Fact & { retracted: boolean })[] {
  return db()
    .query<FactRow, [string, number]>(
      `SELECT * FROM person_facts WHERE student_id = ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(studentId, Math.min(Math.max(limit, 1), 1000))
    .map((row) => ({ ...toFact(row), retracted: !!row.retracted }));
}

/**
 * Who has this fact — the question an outside system actually asks.
 *
 * `value` is compared as text, which is exactly why values are stored as text.
 * Passing a number works because SQLite would have to widen it anyway, so it
 * is stringified here where the reason is visible.
 */
export function peopleWithFact(
  key: string,
  value?: unknown,
  limit = 50,
): (Fact & { studentId: string })[] {
  const capped = Math.min(Math.max(limit, 1), 500);
  const rows =
    value === undefined
      ? db()
          .query<FactRow, [string, number]>(
            `SELECT * FROM current_facts WHERE key = ? ORDER BY student_id LIMIT ?`,
          )
          .all(key, capped)
      : db()
          .query<FactRow, [string, string, number]>(
            `SELECT * FROM current_facts WHERE key = ? AND value = ? ORDER BY student_id LIMIT ?`,
          )
          .all(key, encode(value).value, capped);
  return rows.map((row) => ({ ...toFact(row), studentId: row.student_id }));
}

/** How the population splits on one fact. Meaningless for a photograph, and the point for a personality type. */
export function factDistribution(key: string): { value: string; n: number }[] {
  return db()
    .query<{ value: string; n: number }, [string]>(
      `SELECT value, COUNT(*) AS n FROM current_facts
       WHERE key = ? GROUP BY value ORDER BY n DESC, value`,
    )
    .all(key);
}

/**
 * Every key anybody has ever used, with how many people carry it.
 *
 * Without this a caller has to already know what is in here, which is the
 * difference between a lake you can swim in and one you can only be told about.
 */
export function factKeys(): { key: string; people: number; sources: string[] }[] {
  return db()
    .query<{ key: string; people: number; sources: string }, []>(
      `SELECT key, COUNT(DISTINCT student_id) AS people,
              GROUP_CONCAT(DISTINCT source) AS sources
       FROM current_facts GROUP BY key ORDER BY people DESC, key`,
    )
    .all()
    .map((row) => ({ ...row, sources: (row.sources ?? "").split(",").filter(Boolean).sort() }));
}
