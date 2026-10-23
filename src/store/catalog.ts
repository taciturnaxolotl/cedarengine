/**
 * Sections and courses, per term.
 *
 * A term is replaced wholesale rather than merged: a crawl sees every section
 * that exists, so a section missing from it has been cancelled and should not
 * linger as a ghost seat. Courses are the exception — a sections-only refresh
 * leaves them alone, because requisite text is expensive to fetch and never
 * moves.
 */

import { db } from "../db";

/** The sentinel term for "every course in the catalog, offered or not". */
export const ALL_COURSES = "ALL";

export interface TermCatalog {
  term: string;
  fetchedAt: string;
  sections: any[];
  courses: any[];
}

export interface SectionRow {
  term: string;
  sectionId: string;
  courseId: string;
  code: string | null;
  name: string | null;
  title: string | null;
  faculty: string | null;
  meetings: string | null;
  available: number | null;
  capacity: number | null;
  payload: string;
  fetchedAt: string;
}

export interface CourseRow {
  term: string;
  courseId: string;
  code: string | null;
  subject: string | null;
  number: string | null;
  title: string | null;
  credits: number | null;
  payload: string;
  fetchedAt: string;
}

const SECTION_SELECT = `SELECT term, section_id AS sectionId, course_id AS courseId, code, name,
  title, faculty, meetings, available, capacity, payload, fetched_at AS fetchedAt FROM sections`;

const COURSE_SELECT = `SELECT term, course_id AS courseId, code, subject, number, title, credits,
  payload, fetched_at AS fetchedAt FROM courses`;

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

const number = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Replace a term. Returns the number of sections stored. */
export function replaceTerm(catalog: TermCatalog): number {
  const database = db();
  const insertSection = database.query(
    `INSERT INTO sections (term, section_id, course_id, code, name, title, faculty, meetings,
       available, capacity, payload, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(term, section_id) DO UPDATE SET
       course_id = excluded.course_id, code = excluded.code, name = excluded.name,
       title = excluded.title, faculty = excluded.faculty, meetings = excluded.meetings,
       available = excluded.available, capacity = excluded.capacity,
       payload = excluded.payload, fetched_at = excluded.fetched_at`,
  );
  const insertCourse = database.query(
    `INSERT INTO courses (term, course_id, code, subject, number, title, credits, payload, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(term, course_id) DO UPDATE SET
       code = excluded.code, subject = excluded.subject, number = excluded.number,
       title = excluded.title, credits = excluded.credits,
       payload = excluded.payload, fetched_at = excluded.fetched_at`,
  );
  const clearSections = database.query("DELETE FROM sections WHERE term = ? AND fetched_at < ?");
  const clearCourses = database.query("DELETE FROM courses WHERE term = ? AND fetched_at < ?");

  const run = database.transaction(() => {
    for (const s of catalog.sections) {
      if (!s?.Id) continue;
      insertSection.run(
        catalog.term,
        String(s.Id),
        String(s.CourseId ?? ""),
        text(s.CourseName),
        text(s.SectionNameDisplay),
        text(s.Title),
        text(s.FacultyDisplay),
        text(s.MeetingsDisplay),
        number(s.Available),
        number(s.Capacity),
        JSON.stringify(s),
        catalog.fetchedAt,
      );
    }
    if (catalog.sections.length) clearSections.run(catalog.term, catalog.fetchedAt);

    for (const c of catalog.courses ?? []) {
      if (!c?.Id) continue;
      const code =
        c.SubjectCode && c.Number ? `${c.SubjectCode}-${c.Number}` : text(c.CourseTitleDisplay);
      insertCourse.run(
        catalog.term,
        String(c.Id),
        code,
        text(c.SubjectCode),
        text(c.Number),
        text(c.Title),
        number(c.MinimumCredits),
        JSON.stringify(c),
        catalog.fetchedAt,
      );
    }
    if (catalog.courses?.length) clearCourses.run(catalog.term, catalog.fetchedAt);
  });
  run();
  return catalog.sections.length;
}

export interface SectionQuery {
  term: string;
  code?: string;
  subject?: string;
  courseId?: string;
  open?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

export function searchSections(query: SectionQuery): SectionRow[] {
  const where = ["term = ?"];
  const args: (string | number)[] = [query.term];

  if (query.code) {
    where.push("code = ?");
    args.push(query.code.toUpperCase());
  }
  if (query.subject) {
    where.push("code LIKE ?");
    args.push(`${query.subject.toUpperCase()}-%`);
  }
  if (query.courseId) {
    where.push("course_id = ?");
    args.push(query.courseId);
  }
  if (query.open) where.push("available > 0");
  if (query.q) {
    where.push("(title LIKE ? OR faculty LIKE ? OR name LIKE ?)");
    const like = `%${query.q}%`;
    args.push(like, like, like);
  }

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  return db()
    .query<SectionRow, any[]>(
      `${SECTION_SELECT} WHERE ${where.join(" AND ")} ORDER BY code, name LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset);
}

export interface CourseQuery {
  term?: string;
  code?: string;
  subject?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export function searchCourses(query: CourseQuery): CourseRow[] {
  const where: string[] = ["term = ?"];
  const args: (string | number)[] = [query.term ?? ALL_COURSES];

  if (query.code) {
    where.push("code = ?");
    args.push(query.code.toUpperCase());
  }
  if (query.subject) {
    where.push("subject = ?");
    args.push(query.subject.toUpperCase());
  }
  if (query.q) {
    where.push("(title LIKE ? OR code LIKE ?)");
    args.push(`%${query.q}%`, `${query.q.toUpperCase()}%`);
  }

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  return db()
    .query<CourseRow, any[]>(
      `${COURSE_SELECT} WHERE ${where.join(" AND ")} ORDER BY code LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset);
}

/**
 * Sections by the name the catalog prints on them, e.g. "BIO-2500-01".
 *
 * One query for a whole schedule rather than one per course, and the names
 * that matched nothing come back to the caller rather than vanishing: a
 * section in a booklist and not in the catalog is worth saying out loud.
 */
export function sectionsByName(term: string, names: string[]): SectionRow[] {
  const wanted = [...new Set(names.map((name) => name.toUpperCase()))];
  if (!wanted.length) return [];
  const holes = wanted.map(() => "?").join(", ");
  return db()
    .query<SectionRow, string[]>(
      `${SECTION_SELECT} WHERE term = ? AND UPPER(name) IN (${holes}) ORDER BY name`,
    )
    .all(term, ...wanted);
}

/**
 * The LIKE is a cheap prefilter so SQLite only parses the payloads that could
 * match; json_each is the real test, so "123" never matches "1234".
 */
const TAUGHT_BY = `payload LIKE ? AND EXISTS (
  SELECT 1 FROM json_each(payload, '$.InstructorDetails') i
  WHERE json_extract(i.value, '$.FacultyId') = ?)`;

const taughtArgs = (facultyId: string): [string, string] => [`%${facultyId}%`, facultyId];

/** Sections in a term whose instructors include this directory id. */
export function sectionsTaughtBy(facultyId: string, term: string): SectionRow[] {
  return db()
    .query<SectionRow, string[]>(`${SECTION_SELECT} WHERE term = ? AND ${TAUGHT_BY} ORDER BY name`)
    .all(term, ...taughtArgs(facultyId));
}

/** Terms with at least one such section, oldest first. */
export function termsTaughtBy(facultyId: string): string[] {
  return db()
    .query<{ term: string }, string[]>(
      `SELECT DISTINCT term FROM sections WHERE ${TAUGHT_BY} ORDER BY term`,
    )
    .all(...taughtArgs(facultyId))
    .map((row) => row.term)
    .sort(termOrder);
}

/** "2026FA" before "2027SP" before "2027SU": by year, then spring, summer, fall. */
const termOrder = (a: string, b: string): number => {
  const rank = (t: string) =>
    Number(t.slice(0, 4)) * 10 + ({ SP: 1, SU: 2, FA: 3 }[t.slice(4)] ?? 0);
  return rank(a) - rank(b);
};

/**
 * One course by code, preferring the term asked for and falling back to the
 * full-catalog copy. A requisite often names a course nobody is teaching this
 * year, and answering "no such course" for EGEE-2010 would be a lie.
 */
export function courseByCode(code: string, term?: string): CourseRow | null {
  const database = db();
  const upper = code.toUpperCase();
  if (term) {
    const hit = database
      .query<CourseRow, [string, string]>(`${COURSE_SELECT} WHERE term = ? AND code = ?`)
      .get(term, upper);
    if (hit) return hit;
  }
  return database
    .query<CourseRow, [string, string]>(`${COURSE_SELECT} WHERE term = ? AND code = ?`)
    .get(ALL_COURSES, upper);
}

/**
 * Every building the timetable actually teaches in.
 *
 * The directory only names buildings somebody lives or works in, which misses
 * the ones that are all classrooms — Alford Auditorium has a hundred seats and
 * nobody's office. A campus that cannot place a lecture hall cannot answer
 * where anybody walks.
 */
export function meetingBuildings(term?: string): string[] {
  const rows = term
    ? db()
        .query<{ payload: string }, [string]>("SELECT payload FROM sections WHERE term = ?")
        .all(term)
    : db().query<{ payload: string }, []>("SELECT payload FROM sections").all();

  const names = new Set<string>();
  for (const row of rows) {
    const section = JSON.parse(row.payload) as {
      FormattedMeetingTimes?: { BuildingDisplay?: string; IsOnline?: boolean }[];
    };
    for (const meeting of section.FormattedMeetingTimes ?? []) {
      const building = meeting.BuildingDisplay?.trim();
      if (building && !meeting.IsOnline) names.add(building);
    }
  }
  return [...names].sort();
}

export interface TimetableCell {
  /** 1 is Monday, as Colleague numbers them. */
  day: number;
  /** Hour the meeting starts, 24-hour. */
  hour: number;
  sections: number;
  seats: number;
}

/**
 * When campus is actually in class.
 *
 * A section that meets Monday, Wednesday and Friday is three cells, not one:
 * the question is how busy a given hour is, and that section fills the room
 * three times. Seats are the enrolment, so an 8am lecture for two hundred
 * outweighs a seminar for nine.
 */
export function timetable(term: string): TimetableCell[] {
  const rows = db()
    .query<{ payload: string }, [string]>("SELECT payload FROM sections WHERE term = ?")
    .all(term);

  const cells = new Map<string, TimetableCell>();
  for (const row of rows) {
    const section = JSON.parse(row.payload) as {
      Enrolled?: number;
      FormattedMeetingTimes?: { Days?: number[]; StartTime?: string; IsOnline?: boolean }[];
    };
    for (const meeting of section.FormattedMeetingTimes ?? []) {
      if (meeting.IsOnline || !meeting.StartTime) continue;
      const hour = Number(meeting.StartTime.slice(0, 2));
      if (!Number.isFinite(hour)) continue;
      for (const day of meeting.Days ?? []) {
        const key = `${day}:${hour}`;
        const cell = cells.get(key) ?? { day, hour, sections: 0, seats: 0 };
        cell.sections++;
        cell.seats += section.Enrolled ?? 0;
        cells.set(key, cell);
      }
    }
  }
  return [...cells.values()].sort((a, b) => a.day - b.day || a.hour - b.hour);
}

/** Enrolment against capacity, by subject. How full is what. */
export const subjectLoad = (
  term: string,
): { subject: string; sections: number; enrolled: number; capacity: number }[] =>
  db()
    .query<{ subject: string; sections: number; enrolled: number; capacity: number }, [string]>(
      `SELECT substr(code, 1, instr(code, '-') - 1) AS subject,
              COUNT(*) AS sections,
              SUM(COALESCE(capacity, 0) - COALESCE(available, 0)) AS enrolled,
              SUM(COALESCE(capacity, 0)) AS capacity
       FROM sections WHERE term = ? AND code IS NOT NULL AND instr(code, '-') > 1
       GROUP BY subject ORDER BY enrolled DESC`,
    )
    .all(term);

export interface TermStats {
  term: string;
  sections: number;
  courses: number;
  fetchedAt: string;
}

export const termStats = (): TermStats[] =>
  db()
    .query<TermStats, []>(
      `SELECT term, COUNT(*) AS sections, COUNT(DISTINCT course_id) AS courses,
              MAX(fetched_at) AS fetchedAt
       FROM sections GROUP BY term
       UNION ALL
       SELECT term, 0, COUNT(*), MAX(fetched_at) FROM courses WHERE term = 'ALL' GROUP BY term
       ORDER BY term`,
    )
    .all();

export function writeRule(
  key: { requirement: string; subrequirement: string; group: string },
  courses: string[],
): void {
  db()
    .query(
      `INSERT INTO rule_groups (requirement, subrequirement, grp, courses, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(requirement, subrequirement, grp) DO UPDATE SET
         courses = excluded.courses, fetched_at = excluded.fetched_at`,
    )
    .run(
      key.requirement,
      key.subrequirement,
      key.group,
      JSON.stringify(courses),
      new Date().toISOString(),
    );
}

export function readRule(key: {
  requirement: string;
  subrequirement: string;
  group: string;
}): string[] | null {
  const row = db()
    .query<{ courses: string }, [string, string, string]>(
      "SELECT courses FROM rule_groups WHERE requirement = ? AND subrequirement = ? AND grp = ?",
    )
    .get(key.requirement, key.subrequirement, key.group);
  return row ? (JSON.parse(row.courses) as string[]) : null;
}
