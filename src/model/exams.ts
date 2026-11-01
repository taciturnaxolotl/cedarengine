/**
 * Finals week for one person, or one section.
 *
 * The registrar's table says when each meeting slot sits its exam and that the
 * exam is "held in the regular classroom", so a section's exam is its meeting
 * slot looked up in the table, in the room it already meets in. A booklist's
 * sections, or a professor's, become their whole finals week.
 *
 * The lookup is exact. A section matches a row only when its days are one of
 * the heading's patterns and its start time is one the row lists. Anything
 * else falls to the page's catch-all rule, and says so, because the page
 * itself adds "or another time designated by the instructor".
 */

import type { ExamSchedule, ExamSlot } from "../collect/exams";
import { currentTerm } from "../lib/terms";
import { sectionsByName } from "../store/catalog";
import { examSchedule, examTerms } from "../store/exams";
import { arrange, type Meeting, type ScheduledSection, scheduleFor, teachingFor } from "./schedule";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface Exam {
  section: string;
  title: string | null;
  /**
   * `table` when the meeting slot is printed in the schedule. `inferred` when
   * the start time is printed but the days are an odd shape of the same
   * family, a Monday-Wednesday-Thursday class read off the MWF table.
   * `fallback` when neither, and the page's catch-all applies. `none` when the
   * table does not speak for the section at all, with `why` saying which way.
   */
  rule: "table" | "inferred" | "fallback" | "none";
  why: string | null;
  date: string | null;
  weekday: string | null;
  start: string | null;
  end: string | null;
  building: string | null;
  room: string | null;
  /** The meeting the exam was looked up from: "MWF 09:00". */
  from: string | null;
}

const sameDays = (a: number[], b: number[]) =>
  a.length === b.length && [...a].sort().every((day, i) => day === [...b].sort()[i]);

const weekdayOf = (date: string) => DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? null;

const describe = (meeting: Meeting) =>
  `${meeting.daysDisplay ?? meeting.days.map((d) => "UMTWRFS"[d]).join("")} ${meeting.start}`;

/** In-person meetings, lectures first: a lab's slot is not the course's exam slot. */
function meetingsByWeight(section: ScheduledSection): Meeting[] {
  return section.meetings
    .filter((m) => !m.online && m.days.length && m.start)
    .sort((a, b) => Number(/lab/i.test(a.kind ?? "")) - Number(/lab/i.test(b.kind ?? "")));
}

/** Graduate courses are numbered from 5000; the published table is the undergraduate one. */
const GRADUATE = /-[5-9]\d{3}[A-Z]?(?:-|$)/;

const uncovered = (base: { section: string; title: string | null }, why: string): Exam => ({
  ...base,
  rule: "none",
  why,
  date: null,
  weekday: null,
  start: null,
  end: null,
  building: null,
  room: null,
  from: null,
});

export function examFor(section: ScheduledSection, schedule: ExamSchedule): Exam {
  const base = { section: section.name, title: section.title };
  if (GRADUATE.test(section.name)) {
    return uncovered(base, "graduate course; the published table is the undergraduate one");
  }
  const meetings = meetingsByWeight(section);
  if (!meetings.length) return uncovered(base, "never meets in person");

  const exact = (meeting: Meeting) => (slot: ExamSlot) =>
    slot.classStarts.includes(meeting.start!) &&
    slot.patterns.some((p) => sameDays(p, meeting.days));
  // The headings name a Monday family (MWF, MW, M-R, M-F) and a Tuesday-Thursday
  // one. A class that starts on the hour of a printed row and belongs plainly
  // to one family sits that row's exam, even if its exact days are not listed.
  const family = (meeting: Meeting) => (slot: ExamSlot) =>
    slot.classStarts.includes(meeting.start!) &&
    (meeting.days.includes(1)
      ? slot.patterns.some((p) => p.includes(1))
      : meeting.days.every((d) => d === 2 || d === 4) &&
        slot.patterns.some((p) => sameDays(p, [2, 4])));

  for (const [rule, test] of [
    ["table", exact],
    ["inferred", family],
  ] as const) {
    for (const meeting of meetings) {
      const slot = schedule.slots.find(test(meeting));
      if (!slot) continue;
      return {
        ...base,
        rule,
        why:
          rule === "inferred"
            ? `${describe(meeting)} is not printed; read as the ${slot.heading} row for that hour`
            : null,
        date: slot.date,
        weekday: weekdayOf(slot.date),
        start: slot.start,
        end: slot.end,
        building: meeting.building,
        room: meeting.room,
        from: describe(meeting),
      };
    }
  }

  const usual = meetings[0]!;
  const fallback = schedule.fallback;
  return {
    ...base,
    rule: "fallback",
    why: "meeting slot not in the table; the page's catch-all applies unless the instructor sets another time",
    date: fallback?.date ?? null,
    weekday: fallback ? weekdayOf(fallback.date) : null,
    start: fallback?.start ?? null,
    end: fallback?.end ?? null,
    building: usual.building,
    room: usual.room,
    from: describe(usual),
  };
}

const chronological = (a: Exam, b: Exam) =>
  `${a.date ?? "9"}${a.start ?? ""}${a.section}`.localeCompare(
    `${b.date ?? "9"}${b.start ?? ""}${b.section}`,
  );

/**
 * Two exams at overlapping times on the same day, which somebody has to move.
 * Catch-all exams are left out: every off-grid class lands in the same slot on
 * paper, and the page leaves those to the instructor anyway.
 */
function conflictsOf(exams: Exam[]): [string, string][] {
  const timed = exams.filter(
    (e) => (e.rule === "table" || e.rule === "inferred") && e.date && e.start && e.end,
  );
  const out: [string, string][] = [];
  for (const [i, a] of timed.entries()) {
    for (const b of timed.slice(i + 1)) {
      // Same room, same hour is one class listed under two codes, not a clash.
      const crossListed = a.building === b.building && a.room === b.room && a.start === b.start;
      if (a.date === b.date && a.start! < b.end! && b.start! < a.end! && !crossListed) {
        out.push([a.section, b.section]);
      }
    }
  }
  return out;
}

export interface ExamWeek {
  personId: string;
  name: string | null;
  /** Whose sections these are: the booklist's, or the ones they teach. */
  role: "student" | "instructor";
  term: string;
  exams: Exam[];
  /** Sections the table does not cover: online, or graduate-level. */
  unscheduled: Exam[];
  conflicts: [string, string][];
  /** Sections the booklist named that the catalog has never heard of. */
  unmatched: string[];
  /** The page's own words, including the instructor's right to move things. */
  note: string;
}

/** The term to read when none is asked for: the current one, else the newest held. */
export function defaultExamTerm(): string | null {
  const terms = examTerms();
  return terms.includes(currentTerm()) ? currentTerm() : (terms.at(-1) ?? null);
}

export function examsForSections(term: string, names: string[]): Exam[] | null {
  const schedule = examSchedule(term);
  if (!schedule) return null;
  const { scheduled } = arrange(sectionsByName(term, names));
  return scheduled.map((section) => examFor(section, schedule)).sort(chronological);
}

/**
 * A person's finals week. A student's comes from their booklist; someone with
 * no booklist who teaches gets the exams they proctor.
 */
export function examsFor(personId: string, term?: string): ExamWeek | { missing: string } | null {
  const student = scheduleFor(personId, term);
  const teaching = student ? null : teachingFor(personId, term);
  const source = student ?? teaching;
  if (!source) return null;

  const schedule = examSchedule(source.term);
  if (!schedule) return { missing: source.term };

  const all = [...source.sections, ...source.online].map((s) => examFor(s, schedule));
  const exams = all.filter((e) => e.rule !== "none").sort(chronological);
  return {
    personId,
    name: source.name,
    role: student ? "student" : "instructor",
    term: source.term,
    exams,
    unscheduled: all.filter((e) => e.rule === "none"),
    conflicts: conflictsOf(exams),
    unmatched: student?.unmatched ?? [],
    note: schedule.note,
  };
}
