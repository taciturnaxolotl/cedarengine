import { beforeEach, describe, expect, test } from "bun:test";
import { greyballLevelFor } from "../src/auth/greyball";
import { createToken } from "../src/auth/tokens";
import { parseExamPage } from "../src/collect/exams";
import { useDatabase } from "../src/db";
import { replaceTerm } from "../src/store/catalog";
import { saveExamSchedule } from "../src/store/exams";
import { setGreyball } from "../src/store/greyball";
import { ingestHarvest } from "../src/store/harvest";
import { upsertPeople } from "../src/store/people";
import { call } from "./call";

const AT = "2026-08-29T00:00:00.000Z";
const ADMIN = process.env.BEARER_TOKEN!;

/** One row of the registrar's table, enough that MWF 9 a.m. classes get a slot. */
const EXAM_PAGE = `<html><head><title>Exam Schedule - Fall Semester 2026 | Cedarville University</title></head><body>
<h2>Exam Schedule</h2><p>Final exams for Fall Semester 2026.</p>
<table>
  <tr><th>MWF, MW, M-R, M-F</th><th>Exam Date</th><th>Exam Time</th></tr>
  <tr><td><strong>9 a.m.</strong></td><td>Friday, Dec. 11</td><td>8–10 a.m.</td></tr>
</table></body></html>`;

const book = (department: string, course: string, section: string) => ({
  department,
  course,
  section,
  title: "Some Textbook",
});

const meeting = (days: number[], start: string, end: string, room: string) => ({
  Days: days,
  DaysOfWeekDisplay: days.join("/"),
  StartTime: `${start}:00`,
  EndTime: `${end}:00`,
  InstructionalMethodDisplay: "Lecture",
  BuildingDisplay: "Engineering and Science Ctr",
  RoomDisplay: room,
  IsOnline: false,
});

const section = (name: string, over: Record<string, unknown> = {}) => ({
  Id: name,
  CourseId: name.split("-").slice(0, 2).join("-"),
  CourseName: name.split("-").slice(0, 2).join("-"),
  SectionNameDisplay: name,
  Title: "General Botany",
  FacultyDisplay: "Dr. Robert L. Paris",
  MeetingsDisplay: "",
  MinimumCredits: 4,
  Available: 1,
  Capacity: 20,
  FormattedMeetingTimes: [meeting([1, 3, 5], "09:00", "09:50", "345")],
  ...over,
});

beforeEach(() => {
  useDatabase(":memory:");
  upsertPeople(
    [
      { Id: "1", FirstName: "Ada", LastName: "Lovelace", DormName: "Printy Hall" },
      { Id: "2", FirstName: "Grace", LastName: "Hopper", DormName: "Willetts Hall" },
    ],
    AT,
  );
  replaceTerm({
    term: "2026FA",
    fetchedAt: AT,
    courses: [],
    sections: [
      section("BIO-2500-01"),
      section("BIO-2500-02", { FormattedMeetingTimes: [meeting([2, 4], "14:00", "15:15", "201")] }),
      section("BIO-2500-03", {
        InstructorDetails: [{ FacultyId: "2", FacultyName: "Dr. Hopper" }],
      }),
    ],
  });
  ingestHarvest("2026FA", [{ id: "1", books: [book("BIO", "2500", "02")] }], AT);
  saveExamSchedule(parseExamPage(EXAM_PAGE, "test")!);
});

describe("level 1: invented timetables for that caller only", () => {
  test("the directory itself stays true, the schedule does not, twice the same", async () => {
    const real = await call("GET", "/v1/people/1/schedule?term=2026FA", ADMIN);
    expect((real.body.sections as { name: string }[]).map((s) => s.name)).toEqual(["BIO-2500-02"]);

    setGreyball("env", 1, "trusts nobody");
    const person = await call("GET", "/v1/people/1", ADMIN);
    expect(person.body.firstName).toBe("Ada");
    expect(person.body.lastName).toBe("Lovelace");

    const first = await call("GET", "/v1/people/1/schedule?term=2026FA", ADMIN);
    const second = await call("GET", "/v1/people/1/schedule?term=2026FA", ADMIN);
    expect(first.status).toBe(200);
    const sections = (first.body.sections as { name: string }[]).map((s) => s.name);
    expect(sections).toHaveLength(1);
    expect(sections).not.toContain("BIO-2500-02");
    // The week is built from the same catalog, so the substitution is offered, not invented.
    expect(first.body.term).toBe("2026FA");
    expect(first.body.sections).toEqual(second.body.sections);
    expect((first.body.week as unknown[]).length).toBeGreaterThan(0);
  });

  test("a professor's teaching and proctoring are swapped too", async () => {
    const realExams = await call("GET", "/v1/people/2/exams?term=2026FA", ADMIN);
    expect(JSON.stringify(realExams.body)).toContain("BIO-2500-03");

    setGreyball("env", 1, null);
    const teaching = await call("GET", "/v1/people/2/teaching?term=2026FA", ADMIN);
    expect((teaching.body.sections as { name: string }[]).map((s) => s.name)).not.toContain(
      "BIO-2500-03",
    );
    const exams = await call("GET", "/v1/people/2/exams?term=2026FA", ADMIN);
    expect(exams.status).toBe(200);
    expect(JSON.stringify(exams.body)).not.toContain("BIO-2500-03");
  });

  test("the booklist log cannot be used to cross-check", async () => {
    const real = await call("GET", "/v1/people/1/history", ADMIN);
    expect((real.body.booklists as unknown[]).length).toBeGreaterThan(0);
    setGreyball("env", 1, null);
    expect((await call("GET", "/v1/people/1/history", ADMIN)).body.booklists).toEqual([]);
  });

  test("a caller not on the list sees the real week", async () => {
    setGreyball("env", 1, null);
    const { token } = createToken("other", "reader");
    const untouched = await call("GET", "/v1/people/1/schedule?term=2026FA", token);
    expect((untouched.body.sections as { name: string }[]).map((s) => s.name)).toEqual([
      "BIO-2500-02",
    ]);
  });
});

describe("level 2: invented people for that caller", () => {
  test("search lists decoys, the person route is one, everything else about them is absent", async () => {
    const real = await call("GET", "/v1/people?q=Lovelace", ADMIN);
    expect((real.body.people as { lastName: string }[])[0]?.lastName).toBe("Lovelace");

    setGreyball("env", 2, null);
    // A search decoy keeps the name that was searched for, but the people under it are invented.
    const search = await call("GET", "/v1/people?q=Lovelace", ADMIN);
    expect(
      (search.body.people as { firstName: string; id: string }[]).every(
        (p) => p.firstName !== "Ada",
      ),
    ).toBe(true);
    const person = await call("GET", "/v1/people/1", ADMIN);
    expect(person.status).toBe(200);
    expect(person.body.firstName).not.toBe("Ada");
    expect(person.body.lastName).not.toBe("Lovelace");
    expect((await call("GET", "/v1/people/1/schedule?term=2026FA", ADMIN)).status).toBe(404);
    expect((await call("GET", "/v1/people/1/history", ADMIN)).status).toBe(404);
  });
});

describe("following a person across their tokens", () => {
  const sub = "https://indiko.test/u/kieran";
  const signIn = { actor: `indiko:${sub}`, owner: sub };
  const personalToken = { actor: "token:7", owner: sub };
  const script = { actor: "token:8", owner: null };

  test("greyballing the indiko account covers every personal token it owns", () => {
    const levels = new Map<string, 1 | 2>([[`indiko:${sub}`, 1]]);
    expect(greyballLevelFor(signIn, levels)).toBe(1);
    expect(greyballLevelFor(personalToken, levels)).toBe(1);
    expect(greyballLevelFor(script, levels)).toBeNull();
  });

  test("a token listed on its own still counts, and the stricter level wins", () => {
    expect(greyballLevelFor(script, new Map([["token:8", 2]]))).toBe(2);
    const both = new Map<string, 1 | 2>([
      [`indiko:${sub}`, 1],
      ["token:7", 2],
    ]);
    expect(greyballLevelFor(personalToken, both)).toBe(2);
    expect(greyballLevelFor(signIn, both)).toBe(1);
  });
});

describe("managing the greyball list from the admin API", () => {
  test("set, list, change level, remove", async () => {
    const actor = "indiko:https://indiko.test/u/kieran";
    const set = await call("POST", "/v1/admin/greyball", ADMIN, { actor, level: 1 });
    expect(set.status).toBe(200);

    const roster = await call("GET", "/v1/admin/greyball", ADMIN);
    expect(roster.body.actors).toHaveLength(1);
    expect((roster.body.actors as GreyballRow[])[0]).toMatchObject({ actor, level: 1 });

    await call("POST", "/v1/admin/greyball", ADMIN, { actor, level: 2 });
    const after = await call("GET", "/v1/admin/greyball", ADMIN);
    expect((after.body.actors as GreyballRow[])[0]?.level).toBe(2);

    const removed = await call("POST", "/v1/admin/greyball/remove", ADMIN, { actor });
    expect(removed.status).toBe(200);
    expect((await call("GET", "/v1/admin/greyball", ADMIN)).body.actors).toHaveLength(0);
  });

  test("actors and levels are validated", async () => {
    expect(
      (await call("POST", "/v1/admin/greyball", ADMIN, { actor: "kieran", level: 1 })).status,
    ).toBe(400);
    expect(
      (await call("POST", "/v1/admin/greyball", ADMIN, { actor: "env", level: 3 })).status,
    ).toBe(400);
    expect((await call("POST", "/v1/admin/greyball/remove", ADMIN, { actor: "env" })).status).toBe(
      404,
    );
  });
});

interface GreyballRow {
  actor: string;
  level: number;
}
