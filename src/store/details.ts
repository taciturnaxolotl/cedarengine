/**
 * What a person's own directory page says that the search does not.
 *
 * Two fields, fetched one person at a time by the browser extension: the
 * reunion class and the campus mailbox. (The page prints an email too, but it
 * is always the username at cedarville.edu, so it is derived, not fetched.) They
 * live apart from "people" because the directory sweep rewrites that table on
 * every run, and these arrive on a much slower clock.
 *
 * A mailbox changing or a reunion class slipping a year is the same kind of
 * fact as a dorm move, so it goes in person_events alongside them. The first
 * answer about somebody is not a change, and is not recorded as one.
 */

import { db } from "../db";

export interface DetailRow {
  id: string | number;
  reunionClass?: unknown;
  poBox?: unknown;
}

export interface DetailTally {
  stored: number;
  changed: number;
  unchanged: number;
}

const FIELDS = [
  { column: "reunion_class", key: "reunionClass" },
  { column: "po_box", key: "poBox" },
] as const;

const clean = (raw: unknown): string | null => {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  return text === "" ? null : text;
};

/**
 * File a batch of fetched pages, writing down what moved.
 *
 * Every row touches `fetched_at`, changed or not, so the plan stops asking
 * about them until the staleness window comes back around.
 */
export function putDetails(rows: DetailRow[], at = new Date().toISOString()): DetailTally {
  const database = db();
  const before = database.query<Record<string, string | null>, [string]>(
    "SELECT reunion_class, po_box FROM person_details WHERE student_id = ?",
  );
  const write = database.query(
    `INSERT INTO person_details (student_id, reunion_class, po_box, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(student_id) DO UPDATE SET
       reunion_class = excluded.reunion_class, po_box = excluded.po_box,
       fetched_at = excluded.fetched_at`,
  );
  const event = database.query(
    "INSERT INTO person_events (student_id, at, kind, field, was, now) VALUES (?, ?, 'changed', ?, ?, ?)",
  );

  const tally: DetailTally = { stored: 0, changed: 0, unchanged: 0 };
  const run = database.transaction(() => {
    for (const row of rows) {
      const id = clean(row?.id);
      if (!id) continue;

      const previous = before.get(id);
      const values = FIELDS.map(({ key }) => clean(row[key]));
      write.run(id, ...values, at);

      if (!previous) {
        tally.stored++;
        continue;
      }
      let changed = false;
      FIELDS.forEach(({ column }, i) => {
        const was = previous[column] ?? null;
        const now = values[i] ?? null;
        if (was === now) return;
        changed = true;
        event.run(id, at, column, was, now);
      });
      if (changed) tally.changed++;
      else tally.unchanged++;
    }
  });
  run();
  return tally;
}

/**
 * Record that somebody was asked about and the directory had no page for them.
 *
 * Without a row they stay first in line forever and block everyone behind
 * them, which is the same trap the photo sweep has. An existing row keeps what
 * it knew: one refusal is not evidence that a mailbox went away.
 */
export function markNoDetails(id: string, at = new Date().toISOString()): void {
  db()
    .query(
      `INSERT INTO person_details (student_id, fetched_at) VALUES (?, ?)
       ON CONFLICT(student_id) DO UPDATE SET fetched_at = excluded.fetched_at`,
    )
    .run(id, at);
}
