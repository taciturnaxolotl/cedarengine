/**
 * The registrar's taxonomy: program, department, school.
 *
 * The book says what a degree requires and the directory says who is here;
 * neither says that Actuarial Science and Chemistry are both School of Science
 * and Mathematics. That fact is what makes "close but wrong" measurable — a
 * MechE guessed as CompE is the same school, a MechE guessed as Nursing is not.
 */

import { db } from "../db";
import { programSchools } from "./programs";

export interface Major {
  program: string;
  level: string;
  department: string | null;
  school: string | null;
}

/** Book titles carry a degree suffix the taxonomy does not: "Chemistry — BA". */
export function programKey(title: string): string {
  return title
    .replace(/\s*[—–-]\s*(BA|BS|BSN|BME|BAS|MA|MS|MBA|MDiv|PharmD|DNP|EdD|PhD)\b.*$/i, "")
    .replace(/^(BA|BS|BSN|BME|MA|MS|MBA|MDiv|PharmD|DNP)\s+/i, "")
    .replace(/\s*\(.*?\)\s*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function replaceMajors(rows: Major[], at = new Date().toISOString()): number {
  const database = db();
  const insert = database.query(
    `INSERT INTO majors (program, level, department, school, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(program, level) DO UPDATE SET
       department = excluded.department, school = excluded.school,
       fetched_at = excluded.fetched_at`,
  );
  const clear = database.query("DELETE FROM majors WHERE fetched_at < ?");

  const run = database.transaction(() => {
    for (const row of rows) {
      if (!row.program || !row.level) continue;
      insert.run(row.program, row.level, row.department ?? null, row.school ?? null, at);
    }
    if (rows.length) clear.run(at);
  });
  run();
  return rows.length;
}

export const allMajors = (level?: string): Major[] =>
  level
    ? db()
        .query<Major, [string]>(
          "SELECT program, level, department, school FROM majors WHERE level = ? ORDER BY program",
        )
        .all(level)
    : db()
        .query<Major, []>("SELECT program, level, department, school FROM majors ORDER BY program")
        .all();

export const schools = (): { school: string; programs: number }[] =>
  db()
    .query<{ school: string; programs: number }, []>(
      `SELECT school, COUNT(*) AS programs FROM majors
       WHERE school IS NOT NULL GROUP BY school ORDER BY programs DESC`,
    )
    .all();

let index: Map<string, string> | undefined;

/**
 * The school a program belongs to, matched on the normalised title.
 *
 * The registrar is asked first. Where it has no match, the school the book
 * itself files the program under stands in: the graduate catalog names its
 * degrees "Master of Divinity" where the registrar writes "MDiv, Master of
 * Divinity", and the book knows which school it is printing under.
 *
 * Cached, because the evaluation asks this once per label per guess and the
 * table is three hundred rows that change once a year.
 */
export function schoolOf(title: string): string | null {
  if (!index) {
    index = new Map();
    for (const row of db()
      .query<{ program: string; school: string | null }, []>(
        "SELECT program, school FROM majors WHERE school IS NOT NULL",
      )
      .all()) {
      const key = programKey(row.program);
      if (key && !index.has(key)) index.set(key, row.school!);
    }
    for (const row of programSchools()) {
      const key = programKey(row.title);
      if (key && !index.has(key)) index.set(key, row.school);
    }
  }
  return index.get(programKey(title)) ?? null;
}

/** Called after an import or a book collection, so the next lookup sees it. */
export const forgetSchools = () => {
  index = undefined;
};
