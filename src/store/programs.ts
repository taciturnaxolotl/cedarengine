/**
 * Degree programs, read out of the printed catalog.
 *
 * Colleague knows what a degree requires; the book knows the arithmetic behind
 * it, and it is the only place the two are stated together. The course list on
 * each page is also the vocabulary the major model scores against, so it is
 * lifted into its own column rather than left inside the payload.
 *
 * There are two books a year, undergraduate and graduate, and both feed the
 * model: a seminary student's booklist is only legible against the seminary's
 * programs.
 */

import type { Edition, ProgramPage } from "../collect/book";
import { db } from "../db";

export interface ProgramRow {
  year: string;
  edition: Edition;
  page: number;
  title: string;
  totalCredits: number | null;
  school: string | null;
  courses: string;
  payload: string;
  fetchedAt: string;
}

export interface Program extends Omit<ProgramRow, "courses" | "payload"> {
  courses: string[];
  page: number;
  summary: ProgramPage["summary"];
  doubleCounts: ProgramPage["doubleCounts"];
  sequence: ProgramPage["sequence"];
}

const SELECT = `SELECT year, edition, page, title, total_credits AS totalCredits, school, courses,
  payload, fetched_at AS fetchedAt FROM programs`;

const TOTAL = /^Total\b/i;

const hydrate = (row: ProgramRow): Program => {
  const page = JSON.parse(row.payload) as ProgramPage;
  return {
    year: row.year,
    edition: row.edition,
    page: row.page,
    title: row.title,
    totalCredits: row.totalCredits,
    school: row.school,
    fetchedAt: row.fetchedAt,
    courses: JSON.parse(row.courses) as string[],
    summary: page.summary,
    doubleCounts: page.doubleCounts,
    sequence: page.sequence,
  };
};

/**
 * Replace one edition of a catalog year wholesale, leaving the other alone.
 * Returns how many program pages landed.
 */
export function replaceYear(
  year: string,
  pages: ProgramPage[],
  fetchedAt: string,
  edition: Edition = "undergraduate",
): number {
  const database = db();
  const insert = database.query(
    `INSERT INTO programs
       (year, edition, page, title, total_credits, school, courses, payload, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(year, edition, page) DO UPDATE SET
       title = excluded.title, total_credits = excluded.total_credits,
       school = excluded.school, courses = excluded.courses, payload = excluded.payload,
       fetched_at = excluded.fetched_at`,
  );
  const clear = database.query(
    "DELETE FROM programs WHERE year = ? AND edition = ? AND fetched_at < ?",
  );

  const run = database.transaction(() => {
    for (const page of pages) {
      insert.run(
        year,
        edition,
        page.page,
        page.title,
        page.summary.find((l) => TOTAL.test(l.label))?.min ?? null,
        page.school ?? null,
        JSON.stringify(page.courses),
        JSON.stringify(page),
        fetchedAt,
      );
    }
    if (pages.length) clear.run(year, edition, fetchedAt);
  });
  run();
  return pages.length;
}

export interface ProgramYear {
  year: string;
  programs: number;
  /** Programs per edition, so a year missing its graduate book is visible. */
  editions: Partial<Record<Edition, number>>;
  fetchedAt: string;
}

export function programYears(): ProgramYear[] {
  const rows = db()
    .query<{ year: string; edition: Edition; programs: number; fetchedAt: string }, []>(
      `SELECT year, edition, COUNT(*) AS programs, MAX(fetched_at) AS fetchedAt
       FROM programs GROUP BY year, edition ORDER BY year DESC, edition DESC`,
    )
    .all();
  const years = new Map<string, ProgramYear>();
  for (const row of rows) {
    const year = years.get(row.year) ?? {
      year: row.year,
      programs: 0,
      editions: {},
      fetchedAt: row.fetchedAt,
    };
    year.programs += row.programs;
    year.editions[row.edition] = row.programs;
    if (row.fetchedAt > year.fetchedAt) year.fetchedAt = row.fetchedAt;
    years.set(row.year, year);
  }
  return [...years.values()];
}

/** The most recent year on file, which is what everything defaults to. */
export const latestYear = (): string | null =>
  db().query<{ year: string | null }, []>("SELECT MAX(year) AS year FROM programs").get()?.year ??
  null;

export function listPrograms(year: string, q?: string, edition?: Edition): Program[] {
  const clauses = ["year = ?"];
  const params: string[] = [year];
  if (q) {
    clauses.push("title LIKE ?");
    params.push(`%${q}%`);
  }
  if (edition) {
    clauses.push("edition = ?");
    params.push(edition);
  }
  return db()
    .query<ProgramRow, string[]>(`${SELECT} WHERE ${clauses.join(" AND ")} ORDER BY title`)
    .all(...params)
    .map(hydrate);
}

export function programByPage(
  year: string,
  page: number,
  edition: Edition = "undergraduate",
): Program | null {
  const row = db()
    .query<ProgramRow, [string, string, number]>(
      `${SELECT} WHERE year = ? AND edition = ? AND page = ?`,
    )
    .get(year, edition, page);
  return row ? hydrate(row) : null;
}

/**
 * The vocabulary the major model is built from: every program's course list,
 * from both editions of the year, each tagged with the book it came from.
 */
export const programVocabulary = (
  year: string,
): { title: string; edition: Edition; courses: string[] }[] =>
  db()
    .query<{ title: string; edition: Edition; courses: string }, [string]>(
      "SELECT title, edition, courses FROM programs WHERE year = ?",
    )
    .all(year)
    .map((r) => ({
      title: r.title,
      edition: r.edition,
      courses: JSON.parse(r.courses) as string[],
    }));

/**
 * The school each program's own book files it under, for the programs whose
 * edition says. The registrar's taxonomy names graduate degrees in its own
 * style ("MDiv, Master of Divinity"), so the book is the better witness there.
 */
export const programSchools = (): { title: string; school: string }[] =>
  db()
    .query<{ title: string; school: string }, []>(
      "SELECT DISTINCT title, school FROM programs WHERE school IS NOT NULL",
    )
    .all();
