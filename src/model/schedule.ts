/**
 * One student's week.
 *
 * The join is short but it only works because of a detail the major model
 * discards: the campus store's booklist names the *section* a book was bought
 * for, not just the course. `BIO-2500-01` is one row in the catalog, and that
 * row carries the days, the hour and the room. So a list of books somebody
 * never meant to publish as a timetable is a timetable.
 *
 * Two honest limits. A booklist is only as current as the last harvest, so a
 * course dropped in week three sits here until the next sweep sees it gone —
 * `/v1/people/:id/history` is where that movement is recorded. And a section
 * with no assigned book never appears at all: this is the schedule the
 * bookstore knows about, which is most of it and not all of it.
 */

import { currentTerm } from "../lib/terms";
import { type SectionRow, sectionsByName, sectionsTaughtBy, termsTaughtBy } from "../store/catalog";
import { enrolmentOf } from "../store/harvest";
import { personById } from "../store/people";

/** Colleague counts days the way `Date.getDay` does: Sunday is 0. */
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface Meeting {
  /** 0 is Sunday. A lecture on M/W/F is one meeting with three days. */
  days: number[];
  daysDisplay: string | null;
  /** 24-hour, "09:00". Null for an online section that never meets. */
  start: string | null;
  end: string | null;
  minutes: number;
  kind: string | null;
  building: string | null;
  room: string | null;
  online: boolean;
  startDate: string | null;
  endDate: string | null;
}

export interface ScheduledSection {
  name: string;
  code: string | null;
  title: string | null;
  faculty: string | null;
  sectionId: string;
  credits: number | null;
  meetings: Meeting[];
}

/** One section meeting on one day, which is what a timetable cell holds. */
export interface Block {
  start: string;
  end: string;
  minutes: number;
  section: string;
  title: string | null;
  kind: string | null;
  building: string | null;
  room: string | null;
}

export interface Day {
  day: number;
  label: string;
  minutes: number;
  blocks: Block[];
}

export interface Schedule {
  studentId: string;
  name: string | null;
  term: string;
  /** Every term a booklist has been harvested for, whichever one was asked for. */
  terms: string[];
  dorm: string | null;
  credits: number;
  /** Contact minutes in a full week, online sections excluded. */
  minutes: number;
  sections: ScheduledSection[];
  week: Day[];
  online: ScheduledSection[];
  /** Sections the booklist named and the catalog has never heard of. */
  unmatched: string[];
  harvestedAt: string | null;
}

interface RawMeeting {
  Days?: number[];
  DaysOfWeekDisplay?: string;
  StartTime?: string;
  EndTime?: string;
  InstructionalMethodDisplay?: string;
  BuildingDisplay?: string;
  RoomDisplay?: string;
  IsOnline?: boolean;
  StartDate?: string;
  EndDate?: string;
}

const clean = (value: string | undefined): string | null => value?.trim() || null;

/** "09:50:00" is three fields of precision for a thing measured in minutes. */
const clock = (value: string | undefined): string | null => {
  const parts = clean(value)?.split(":");
  return parts && parts.length >= 2 ? `${parts[0]}:${parts[1]}` : null;
};

const minutesBetween = (start: string | null, end: string | null): number => {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return Math.max(0, eh! * 60 + em! - (sh! * 60 + sm!));
};

function meetingsOf(section: SectionRow): Meeting[] {
  const payload = JSON.parse(section.payload) as { FormattedMeetingTimes?: RawMeeting[] };
  return (payload.FormattedMeetingTimes ?? []).map((raw) => {
    const start = clock(raw.StartTime);
    const end = clock(raw.EndTime);
    return {
      days: (raw.Days ?? []).filter((day) => day >= 0 && day <= 6),
      daysDisplay: clean(raw.DaysOfWeekDisplay),
      start,
      end,
      minutes: minutesBetween(start, end),
      kind: clean(raw.InstructionalMethodDisplay),
      building: clean(raw.BuildingDisplay),
      room: clean(raw.RoomDisplay),
      online: raw.IsOnline === true,
      startDate: clean(raw.StartDate),
      endDate: clean(raw.EndDate),
    };
  });
}

const creditsOf = (section: SectionRow): number | null => {
  const payload = JSON.parse(section.payload) as { MinimumCredits?: number | null };
  return typeof payload.MinimumCredits === "number" ? payload.MinimumCredits : null;
};

/** A section is online when nothing about it has a day and an hour. */
const meetsInPerson = (meetings: Meeting[]): boolean =>
  meetings.some((meeting) => !meeting.online && meeting.days.length && meeting.start);

/** Sections laid out by weekday, each day's blocks in order. */
function arrange(rows: SectionRow[]): { scheduled: ScheduledSection[]; week: Day[] } {
  const scheduled: ScheduledSection[] = rows.map((row) => ({
    name: row.name ?? "",
    code: row.code,
    title: row.title,
    faculty: row.faculty,
    sectionId: row.sectionId,
    credits: creditsOf(row),
    meetings: meetingsOf(row),
  }));

  const week: Day[] = DAY_NAMES.map((label, day) => ({ day, label, minutes: 0, blocks: [] }));
  for (const section of scheduled) {
    for (const meeting of section.meetings) {
      if (!meeting.start || !meeting.end || meeting.online) continue;
      for (const day of meeting.days) {
        week[day]!.blocks.push({
          start: meeting.start,
          end: meeting.end,
          minutes: meeting.minutes,
          section: section.name,
          title: section.title,
          kind: meeting.kind,
          building: meeting.building,
          room: meeting.room,
        });
        week[day]!.minutes += meeting.minutes;
      }
    }
  }
  for (const day of week) day.blocks.sort((a, b) => a.start.localeCompare(b.start));

  return { scheduled, week };
}

export function scheduleFor(studentId: string, term?: string): Schedule | null {
  const harvested = enrolmentOf(studentId);
  if (!harvested.length) return null;

  const wanted =
    term ?? harvested.find((row) => row.term === currentTerm())?.term ?? harvested.at(-1)!.term;
  const held = harvested.find((row) => row.term === wanted);
  const person = personById(studentId);

  const rows = held ? sectionsByName(wanted, held.sections) : [];
  const found = new Set(rows.map((row) => (row.name ?? "").toUpperCase()));

  const { scheduled, week } = arrange(rows);

  return {
    studentId,
    name: person
      ? `${person.nickname ?? person.firstName ?? ""} ${person.lastName ?? ""}`.trim()
      : null,
    term: wanted,
    terms: harvested.map((row) => row.term),
    dorm: person?.dormName ?? null,
    credits: scheduled.reduce((total, section) => total + (section.credits ?? 0), 0),
    minutes: week.reduce((total, day) => total + day.minutes, 0),
    sections: scheduled.filter((section) => meetsInPerson(section.meetings)),
    week: week.filter((day) => day.blocks.length),
    online: scheduled.filter((section) => !meetsInPerson(section.meetings)),
    unmatched: (held?.sections ?? []).filter((name) => !found.has(name.toUpperCase())),
    harvestedAt: held?.fetchedAt ?? null,
  };
}

export interface Teaching {
  facultyId: string;
  name: string | null;
  term: string;
  /** Every term with at least one section this person teaches. */
  terms: string[];
  credits: number;
  minutes: number;
  sections: ScheduledSection[];
  week: Day[];
  online: ScheduledSection[];
}

/**
 * What a professor teaches. Colleague names every instructor on a section by
 * the same id the directory uses, so this is a lookup rather than a guess at
 * matching "Dr. Nathan E. Averbeck" against a directory row.
 */
export function teachingFor(facultyId: string, term?: string): Teaching | null {
  const terms = termsTaughtBy(facultyId);
  if (!terms.length) return null;
  const wanted = term ?? (terms.includes(currentTerm()) ? currentTerm() : terms.at(-1)!);
  const rows = sectionsTaughtBy(facultyId, wanted);
  const { scheduled, week } = arrange(rows);
  const person = personById(facultyId);

  return {
    facultyId,
    name: person
      ? `${person.nickname ?? person.firstName ?? ""} ${person.lastName ?? ""}`.trim()
      : null,
    term: wanted,
    terms,
    credits: scheduled.reduce((total, section) => total + (section.credits ?? 0), 0),
    minutes: week.reduce((total, day) => total + day.minutes, 0),
    sections: scheduled.filter((section) => meetsInPerson(section.meetings)),
    week: week.filter((day) => day.blocks.length),
    online: scheduled.filter((section) => !meetsInPerson(section.meetings)),
  };
}
