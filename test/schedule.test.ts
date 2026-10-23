import { beforeEach, describe, expect, test } from "bun:test";
import { useDatabase } from "../src/db";
import { scheduleFor } from "../src/model/schedule";
import { replaceTerm } from "../src/store/catalog";
import { ingestHarvest, sectionsFromBooks } from "../src/store/harvest";
import { upsertPeople } from "../src/store/people";

const AT = "2026-08-29T00:00:00.000Z";

/** A book the way the campus store lists it: every field carries its own label. */
const book = (department: string, course: string, section: string) => ({
  department,
  course,
  section,
  title: "Some Textbook",
});

const meeting = (days: number[], start: string, end: string, room: string, kind = "Lecture") => ({
  Days: days,
  DaysOfWeekDisplay: days.join("/"),
  StartTime: `${start}:00`,
  EndTime: `${end}:00`,
  InstructionalMethodDisplay: kind,
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
  upsertPeople([{ Id: "1", FirstName: "Ada", LastName: "Lovelace", DormName: "Printy Hall" }], AT);
  replaceTerm({
    term: "2026FA",
    fetchedAt: AT,
    courses: [],
    sections: [
      section("BIO-2500-01"),
      section("BIO-2500-02", {
        FormattedMeetingTimes: [meeting([2, 4], "14:00", "15:15", "201")],
      }),
      section("CHEM-2210-01", {
        Title: "Analytical Chemistry I",
        MinimumCredits: 3,
        FormattedMeetingTimes: [
          meeting([2], "09:00", "09:50", "102"),
          meeting([4], "14:00", "16:50", "117", "Laboratory"),
        ],
      }),
    ],
  });
});

describe("reading a section out of a booklist", () => {
  test("department, course and section collapse to the catalog's name", () => {
    expect(sectionsFromBooks([book("BIO-Biology", "2500-General Botany", "01-01")])).toEqual([
      "BIO-2500-01",
    ]);
  });

  test("a booklist with no section number yields nothing to look up", () => {
    expect(sectionsFromBooks([book("BIO-Biology", "2500-General Botany", "")])).toEqual([]);
  });

  test("four books for one section are one section", () => {
    const books = Array.from({ length: 4 }, () =>
      book("BIO-Biology", "2500-General Botany", "01-01"),
    );
    expect(sectionsFromBooks(books)).toEqual(["BIO-2500-01"]);
  });
});

describe("a student's week", () => {
  test("the section in the booklist is the section in the schedule", () => {
    ingestHarvest("2026FA", [{ id: "1", books: [book("BIO", "2500", "02")] }], AT);
    const schedule = scheduleFor("1", "2026FA")!;

    // Both sections of BIO-2500 exist; only the one they bought books for is theirs.
    expect(schedule.sections.map((s) => s.name)).toEqual(["BIO-2500-02"]);
    expect(schedule.week.map((day) => day.label)).toEqual(["Tuesday", "Thursday"]);
  });

  test("a course meeting twice a week fills two days from one meeting row", () => {
    ingestHarvest("2026FA", [{ id: "1", books: [book("CHEM", "2210", "01")] }], AT);
    const schedule = scheduleFor("1", "2026FA")!;

    const thursday = schedule.week.find((day) => day.label === "Thursday")!;
    expect(thursday.blocks).toHaveLength(1);
    expect(thursday.blocks[0]).toMatchObject({
      start: "14:00",
      end: "16:50",
      kind: "Laboratory",
      room: "117",
    });
    // 50 minutes of lecture and 170 of lab.
    expect(schedule.minutes).toBe(220);
  });

  test("credits are summed off the sections, not guessed", () => {
    ingestHarvest(
      "2026FA",
      [{ id: "1", books: [book("BIO", "2500", "01"), book("CHEM", "2210", "01")] }],
      AT,
    );
    expect(scheduleFor("1", "2026FA")?.credits).toBe(7);
  });

  test("a section the catalog has never heard of is reported, not dropped", () => {
    ingestHarvest("2026FA", [{ id: "1", books: [book("BIO", "9999", "01")] }], AT);
    const schedule = scheduleFor("1", "2026FA")!;

    expect(schedule.sections).toEqual([]);
    expect(schedule.unmatched).toEqual(["BIO-9999-01"]);
  });

  test("an online section is held apart from the week rather than placed in it", () => {
    replaceTerm({
      term: "2026FA",
      fetchedAt: "2026-08-30T00:00:00.000Z",
      courses: [],
      sections: [
        section("PEF-1990-Z01", {
          Title: "Phys Act & Healthy Living",
          MinimumCredits: 1,
          FormattedMeetingTimes: [],
        }),
      ],
    });
    ingestHarvest("2026FA", [{ id: "1", books: [book("PEF", "1990", "Z01")] }], AT);
    const schedule = scheduleFor("1", "2026FA")!;

    expect(schedule.sections).toEqual([]);
    expect(schedule.online.map((s) => s.name)).toEqual(["PEF-1990-Z01"]);
    expect(schedule.minutes).toBe(0);
  });

  test("nobody with a booklist has no schedule to give", () => {
    expect(scheduleFor("1", "2026FA")).toBeNull();
  });

  test("asking for a term nobody harvested answers empty rather than wrong", () => {
    ingestHarvest("2026FA", [{ id: "1", books: [book("BIO", "2500", "01")] }], AT);
    const schedule = scheduleFor("1", "2027SP")!;

    expect(schedule.term).toBe("2027SP");
    expect(schedule.terms).toEqual(["2026FA"]);
    expect(schedule.sections).toEqual([]);
  });
});

describe("what a professor teaches", () => {
  const instructors = (...ids: string[]) => ({
    InstructorDetails: ids.map((id) => ({ FacultyId: id, FacultyName: `Dr. ${id}` })),
  });

  beforeEach(() => {
    replaceTerm({
      term: "2026FA",
      fetchedAt: AT,
      courses: [],
      sections: [
        section("MATH-1715-02", { Title: "Calculus II", ...instructors("1532283") }),
        section("MATH-4450-01", {
          Title: "Topology",
          ...instructors("1532283", "999"),
          FormattedMeetingTimes: [meeting([1, 3], "15:00", "16:15", "205")],
        }),
        section("MATH-1710-01", { Title: "Calculus I", ...instructors("15322830") }),
      ],
    });
  });

  test("finds sections by instructor id, including shared ones", async () => {
    const { teachingFor } = await import("../src/model/schedule");
    const t = teachingFor("1532283");
    expect(t?.term).toBe("2026FA");
    expect(t?.sections.map((s) => s.name)).toEqual(["MATH-1715-02", "MATH-4450-01"]);
    expect(t?.week.find((d) => d.day === 1)?.blocks.map((b) => b.section)).toEqual([
      "MATH-1715-02",
      "MATH-4450-01",
    ]);
  });

  test("an id that is a prefix of another does not match it", async () => {
    const { teachingFor } = await import("../src/model/schedule");
    expect(teachingFor("153228")).toBeNull();
    expect(teachingFor("15322830")?.sections.map((s) => s.name)).toEqual(["MATH-1710-01"]);
  });

  test("nobody who teaches nothing", async () => {
    const { teachingFor } = await import("../src/model/schedule");
    expect(teachingFor("1")).toBeNull();
  });
});
