/**
 * The final exam schedule, off the registrar's pages.
 *
 * Cedarville does not schedule exams per course. It publishes one table per
 * semester that maps a class's regular meeting slot to an exam slot: a MWF
 * 9 a.m. class sits its final on Friday from 8 to 10, in its usual room. So
 * the table is small, and the interesting part is the join: combined with a
 * booklist's sections it becomes one person's finals week.
 *
 * The pages are hand-edited HTML and the editing shows. One semester writes
 * "8 a.m." and the next "8:00 a.m."; the dashes wander between en dashes and
 * hyphens; dates carry no year. Everything below reads the table loosely and
 * then commits to exact values, so a match is a match and nothing is fuzzy
 * after parsing.
 */

import { textOf } from "./book";

/** 24-hour "08:00", the way the schedule model writes times. */
type Clock = string;

export interface ExamSlot {
  /** The day patterns the table heading names, as sets of weekdays (0 is Sunday). */
  patterns: number[][];
  /** The heading as printed: "MWF, MW, M-R, M-F". */
  heading: string;
  /** Class start times this row covers. "8 or 8:30 a.m." is two. */
  classStarts: Clock[];
  /** ISO date, "2026-12-09". */
  date: string;
  start: Clock;
  end: Clock;
}

export interface ExamSchedule {
  /** Colleague term code, "2026FA". */
  term: string;
  title: string;
  source: string;
  slots: ExamSlot[];
  /**
   * Where a class meeting at any other time sits its exam, as the page's prose
   * states it. Null when the sentence could not be read, in which case the
   * text is still kept so nothing is silently dropped.
   */
  fallback: { date: string; start: Clock; end: Clock } | null;
  note: string;
  fetchedAt: string;
}

export const EXAM_PAGES = ["exam-fall", "exam-spring"] as const;
export const examUrl = (page: string) =>
  `https://www.cedarville.edu/offices/registrar/undergraduate/${page}`;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const LETTER: Record<string, number> = { U: 0, M: 1, T: 2, W: 3, R: 4, F: 5, S: 6 };
const DASH = /\s*[–—-]\s*/;

const tidy = (html: string) => textOf(html).replace(/\s+/g, " ").trim();
const pad = (n: number) => String(n).padStart(2, "0");

/** "MWF" is three days and "M-R" is Monday through Thursday. */
export function daysOf(pattern: string): number[] {
  const letters = pattern.replace(/\s/g, "");
  const range = letters.split(DASH);
  if (range.length === 2 && range[0]!.length === 1 && range[1]!.length === 1) {
    const from = LETTER[range[0]!];
    const to = LETTER[range[1]!];
    if (from === undefined || to === undefined) return [];
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  return [...letters].map((l) => LETTER[l]).filter((d): d is number => d !== undefined);
}

/**
 * "10:30 a.m." to "10:30". A time printed without a meridiem borrows one,
 * because the page writes ranges as "1–3 p.m." and lists as "8 or 8:30 a.m.".
 */
function clock(text: string, meridiem?: string): Clock | null {
  const m = text.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const half = (m[3] ?? meridiem ?? "").toLowerCase().startsWith("p") ? "pm" : "am";
  if (half === "pm" && hour < 12) hour += 12;
  if (half === "am" && hour === 12) hour = 0;
  return `${pad(hour)}:${m[2] ?? "00"}`;
}

const meridiemOf = (text: string) => text.match(/([ap])\.?m\.?\s*$/i)?.[1];

/** "8 or 8:30 a.m." to ["08:00", "08:30"]. */
export function classStarts(text: string): Clock[] {
  const parts = text.split(/\s+or\s+|,\s*/);
  const shared = meridiemOf(text);
  return parts.map((p) => clock(p, shared)).filter((c): c is Clock => c !== null);
}

/**
 * "10:30 a.m.–12:30 p.m." or "1–3 p.m." to a start and an end. A bare start
 * takes the end's meridiem unless that would put it after the end, which is
 * how "11–1 p.m." would read if the page ever printed one.
 */
export function timeRange(text: string): { start: Clock; end: Clock } | null {
  const [left, right] = text.trim().split(DASH);
  if (!left || !right) return null;
  const end = clock(right);
  if (!end) return null;
  let start = clock(left, meridiemOf(left) ?? meridiemOf(right));
  if (start && !meridiemOf(left) && start > end) start = clock(left, "a");
  return start ? { start, end } : null;
}

/** "Wednesday, Dec. 9" in a known year to "2026-12-09". */
export function dateOf(text: string, year: number): string | null {
  // The weekday is followed by a comma, so only the month sits directly
  // before a day number.
  const m = text.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  if (month < 0) return null;
  return `${year}-${pad(month + 1)}-${pad(Number(m[2]))}`;
}

/** "Exam Schedule - Fall Semester 2026" to "2026FA". */
export function termOf(title: string): string | null {
  const m = title.match(/(Fall|Spring|Summer)\s+(?:Semester\s+)?(\d{4})/i);
  if (!m) return null;
  const code = { fall: "FA", spring: "SP", summer: "SU" }[m[1]!.toLowerCase()];
  return `${m[2]}${code}`;
}

/**
 * The prose rule for classes off the grid: "on Thursday, 3:30–5:30 p.m." or
 * "on Friday at 1–3 p.m.". The weekday becomes a date by finding it in the
 * week the table's own dates fall in.
 */
function fallbackOf(note: string, slots: ExamSlot[]): ExamSchedule["fallback"] {
  const m = note.match(
    new RegExp(
      `on (${WEEKDAYS.join("|")}),?\\s*(?:at\\s+)?([\\d:]+\\s*(?:[ap]\\.?m\\.?)?\\s*[–—-]\\s*[\\d:]+\\s*[ap]\\.?m\\.?)`,
      "i",
    ),
  );
  if (!m || !slots.length) return null;
  const range = timeRange(m[2]!);
  const weekday = WEEKDAYS.indexOf(m[1]!.toLowerCase());
  if (!range) return null;
  const first = slots.map((s) => s.date).sort()[0]!;
  for (let i = 0; i < 7; i++) {
    const day = new Date(`${first}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + i);
    if (day.getUTCDay() === weekday) return { date: day.toISOString().slice(0, 10), ...range };
  }
  return null;
}

/** Read one registrar exam page. Undefined when it is not one. */
export function parseExamPage(
  html: string,
  source: string,
  fetchedAt = new Date().toISOString(),
): ExamSchedule | undefined {
  const title = tidy(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s*\|.*$/, "");
  const term = termOf(title);
  if (!term) return undefined;
  const year = Number(term.slice(0, 4));

  const at = html.search(/Exam Schedule<\/h2>/i);
  const body = at >= 0 ? html.slice(at) : html;
  const note = tidy(body.match(/<p>([\s\S]*?)<\/p>/i)?.[1] ?? "");

  const slots: ExamSlot[] = [];
  for (const table of body.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []).map((row) =>
      (row.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) ?? []).map(tidy),
    );
    const [head, ...rest] = rows;
    const heading = head?.[0] ?? "";
    const patterns = heading
      .split(",")
      .map(daysOf)
      .filter((d) => d.length);
    if (!patterns.length) continue;
    for (const [when, date, time] of rest) {
      const starts = classStarts(when ?? "");
      const iso = dateOf(date ?? "", year);
      const range = timeRange(time ?? "");
      if (starts.length && iso && range) {
        slots.push({ patterns, heading, classStarts: starts, date: iso, ...range });
      }
    }
  }
  if (!slots.length) return undefined;

  return { term, title, source, slots, fallback: fallbackOf(note, slots), note, fetchedAt };
}

/** Every exam page the registrar currently publishes. */
export async function fetchExamSchedules(get: typeof fetch = fetch): Promise<ExamSchedule[]> {
  const out: ExamSchedule[] = [];
  for (const page of EXAM_PAGES) {
    const url = examUrl(page);
    const response = await get(url);
    if (!response.ok) continue;
    const schedule = parseExamPage(await response.text(), url);
    if (schedule) out.push(schedule);
  }
  return out;
}
