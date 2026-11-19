/**
 * A plausible week for someone who must not have their real one read.
 *
 * The decoy keeps the shape of the truth — the same terms, the same number of
 * courses, a name and a dorm — but swaps every section for another one the
 * catalog actually offers in that term. Swaps stay in the person's field where
 * possible: the subject comes from their real course, and when there is a
 * choice it is at the same level, so a sophomore's invented week does not
 * contain a senior seminar. The catalog supplies the meeting times, rooms and
 * instructors of the substitutes, so nothing is made up that the directory
 * would contradict.
 *
 * The choice is seeded by (person, term, section), so the same person always
 * gets the same invented week; a scraper comparing two runs finds no wobble.
 * A section with no plausible substitute is dropped, never kept: the real
 * section must not survive into an invented week.
 */

import { stream } from "../lib/seeded";
import { type SectionRow, searchSections } from "../store/catalog";
import { examWeekFor } from "./exams";
import {
  arrange,
  type Day,
  meetsInPerson,
  type Schedule,
  type ScheduledSection,
  scheduleFor,
  type Teaching,
  teachingFor,
} from "./schedule";

const subjectOf = (name: string) => name.split("-")[0] ?? name;
const levelOf = (name: string) => Math.floor(Number(name.split("-")[1] ?? 0) / 1000);

interface Weeked {
  term: string;
  credits: number;
  minutes: number;
  sections: ScheduledSection[];
  week: Day[];
  online: ScheduledSection[];
}

/** Replacements for every section on a page, never reusing one twice and never the real one. */
function substitute(term: string, personId: string, sections: ScheduledSection[]): SectionRow[] {
  // One read per pool, however many sections the week has: subject pools, plus the whole term.
  const pools = new Map<string, SectionRow[]>();
  const pool = (subject?: string) => {
    const key = subject ?? "*";
    let rows = pools.get(key);
    if (!rows) pools.set(key, (rows = searchSections({ term, subject, limit: 500 })));
    return rows;
  };
  const used = new Set<string>();
  const tiers = (real: string) => {
    const subject = subjectOf(real);
    const level = levelOf(real);
    const unused = (rows: SectionRow[]) =>
      rows.filter((row) => row.name !== real && row.name !== null && !used.has(row.name));
    return [
      unused(pool(subject)).filter((row) => levelOf(row.name ?? "") === level),
      unused(pool(subject)),
      unused(pool()),
    ].find((rows) => rows.length);
  };
  return sections.flatMap((section) => {
    const real = section.name;
    const chosen = tiers(real);
    if (!chosen) return [];
    const row = chosen[stream(`schedule:${personId}:${term}:${real}`)() % chosen.length]!;
    used.add(row.name!);
    return [row];
  });
}

/** A week of the same shape, its sections swapped: whatever carries sections, student or teaching. */
function substituted<T extends Weeked>(real: T, personId: string): T {
  const rows = substitute(real.term, personId, [...real.sections, ...real.online]);
  const { scheduled, week } = arrange(rows);
  return {
    ...real,
    credits: scheduled.reduce((total, section) => total + (section.credits ?? 0), 0),
    minutes: week.reduce((total, day) => total + day.minutes, 0),
    sections: scheduled.filter((section) => meetsInPerson(section.meetings)),
    week: week.filter((day) => day.blocks.length),
    online: scheduled.filter((section) => !meetsInPerson(section.meetings)),
  };
}

/** The generated week, or null when there is no real week to obscure. */
export function generatedScheduleFor(studentId: string, term?: string): Schedule | null {
  const real = scheduleFor(studentId, term);
  return real ? { ...substituted(real, studentId), unmatched: [] } : null;
}

/** The generated teaching load, for a professor whose whereabouts level 1 must also obscure. */
export function generatedTeachingFor(facultyId: string, term?: string): Teaching | null {
  const real = teachingFor(facultyId, term);
  return real ? substituted(real, facultyId) : null;
}

/** Finals for whichever invented week the person has, so the exam page cannot cross-check the real one. */
export function generatedExamsFor(personId: string, term?: string) {
  const student = generatedScheduleFor(personId, term);
  if (student) return examWeekFor(personId, "student", student);
  const teaching = generatedTeachingFor(personId, term);
  return teaching ? examWeekFor(personId, "instructor", { ...teaching, unmatched: [] }) : null;
}
