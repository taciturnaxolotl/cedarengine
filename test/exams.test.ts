import { describe, expect, test } from "bun:test";
import {
  classStarts,
  dateOf,
  daysOf,
  type ExamSchedule,
  parseExamPage,
  termOf,
  timeRange,
} from "../src/collect/exams";
import { examFor } from "../src/model/exams";
import type { Meeting, ScheduledSection } from "../src/model/schedule";

const row = (cells: string[], tag = "td") =>
  `<tr>${cells.map((c) => `<${tag} style="text-align: center">${c}</${tag}>`).join("")}</tr>`;

// The two semesters' pages, as differently as they were actually typed.
const FALL = `<html><head><title>
	Exam Schedule - Fall Semester 2026 | Cedarville University</title></head><body>
<h2>Exam Schedule</h2>
<p>Final exams for Fall Semester 2026 will be held in the regular classrooms where the classes
meet during the semester. Classes which meet at times other than listed below will have their
exams on Thursday, 3:30–5:30 p.m. or another time designated by the instructor.</p>
<table>${row(["MWF, MW, M-R, M-F", "Exam Date", "Exam Time"], "th")}
${row(["<strong>9 a.m.</strong>", "Friday, Dec. 11", "8–10 a.m."])}
${row(["<strong>11 a.m.</strong>", "Wednesday, Dec. 9", "10:30 a.m.–12:30 p.m. "])}
</table><p>&nbsp;</p>
<table>${row(["TR", "Exam Date", "Exam Time"], "th")}
${row(["<strong>12 or 12:30 p.m.</strong>", "Tuesday, Dec. 8&nbsp;", "10:30 a.m.–12:30 p.m."])}
${row(["<strong>2 p.m.</strong>", "Tuesday, Dec. 8", "1–3 p.m."])}
</table></body></html>`;

const SPRING = FALL.replace("Fall Semester 2026 |", "Spring Semester 2027 |")
  .replace("on Thursday, 3:30–5:30 p.m.", "on Friday at 1–3 p.m.")
  .replace("M-R", "M–R")
  .replace("Friday, Dec. 11", "Friday, April 30")
  .replace("Wednesday, Dec. 9", "Wednesday, April 28")
  .replaceAll("Tuesday, Dec. 8", "Tuesday, April 27")
  .replace("<strong>9 a.m.</strong>", "<strong>9:00 a.m.</strong>")
  .replace("8–10 a.m.", "8:00–10:00 a.m.");

describe("reading the registrar's page", () => {
  test("the small parsers commit to exact values", () => {
    expect(daysOf("MWF")).toEqual([1, 3, 5]);
    expect(daysOf("M-R")).toEqual([1, 2, 3, 4]);
    expect(daysOf("M–F")).toEqual([1, 2, 3, 4, 5]);
    expect(daysOf("TR")).toEqual([2, 4]);
    expect(classStarts("8 or 8:30 a.m.")).toEqual(["08:00", "08:30"]);
    expect(classStarts("12:00 or 12:30 p.m.")).toEqual(["12:00", "12:30"]);
    expect(timeRange("1–3 p.m.")).toEqual({ start: "13:00", end: "15:00" });
    expect(timeRange("10:30 a.m.–12:30 p.m.")).toEqual({ start: "10:30", end: "12:30" });
    expect(timeRange("11–1 p.m.")).toEqual({ start: "11:00", end: "13:00" });
    expect(dateOf("Wednesday, Dec. 9", 2026)).toBe("2026-12-09");
    expect(dateOf("Friday, April 30", 2027)).toBe("2027-04-30");
    expect(termOf("Exam Schedule - Spring Semester 2027")).toBe("2027SP");
  });

  test("a fall page becomes a term's table", () => {
    const fall = parseExamPage(FALL, "fall")!;
    expect(fall.term).toBe("2026FA");
    expect(fall.slots).toHaveLength(4);
    expect(fall.slots[0]).toMatchObject({
      patterns: [
        [1, 3, 5],
        [1, 3],
        [1, 2, 3, 4],
        [1, 2, 3, 4, 5],
      ],
      classStarts: ["09:00"],
      date: "2026-12-11",
      start: "08:00",
      end: "10:00",
    });
    expect(fall.slots[2]).toMatchObject({ classStarts: ["12:00", "12:30"], date: "2026-12-08" });
    expect(fall.fallback).toEqual({ date: "2026-12-10", start: "15:30", end: "17:30" });
  });

  test("the spring page's different typing reads the same way", () => {
    const spring = parseExamPage(SPRING, "spring")!;
    expect(spring.term).toBe("2027SP");
    expect(spring.slots[0]).toMatchObject({ classStarts: ["09:00"], date: "2027-04-30" });
    expect(spring.slots[0]!.patterns).toContainEqual([1, 2, 3, 4]);
    expect(spring.fallback).toEqual({ date: "2027-04-30", start: "13:00", end: "15:00" });
  });

  test("a page that is not an exam schedule is not one", () => {
    expect(parseExamPage("<title>Page Not Found</title>", "x")).toBeUndefined();
  });
});

const meeting = (days: number[], start: string, kind = "Lecture"): Meeting => ({
  days,
  daysDisplay: null,
  start,
  end: null,
  minutes: 50,
  kind,
  building: "Engineering and Science Ctr",
  room: "101",
  online: false,
  startDate: null,
  endDate: null,
});

const section = (name: string, meetings: Meeting[]): ScheduledSection => ({
  name,
  code: name.split("-").slice(0, 2).join("-"),
  title: null,
  faculty: null,
  sectionId: name,
  credits: 3,
  meetings,
});

describe("a section's exam", () => {
  const fall = parseExamPage(FALL, "fall") as ExamSchedule;

  test("is the table row for its days and hour, in its own room", () => {
    const exam = examFor(section("EGCP-1010-01", [meeting([1, 3, 5], "09:00")]), fall);
    expect(exam).toMatchObject({
      rule: "table",
      date: "2026-12-11",
      weekday: "Friday",
      start: "08:00",
      room: "101",
    });
  });

  test("reads the lecture, not the lab", () => {
    const exam = examFor(
      section("CHEM-1110-01", [meeting([2], "14:00", "Lab"), meeting([2, 4], "12:30")]),
      fall,
    );
    expect(exam).toMatchObject({ rule: "table", date: "2026-12-08", start: "10:30" });
  });

  test("an odd shape of a printed family is inferred, and says so", () => {
    const exam = examFor(section("MATH-1710-01", [meeting([1, 3, 4], "11:00")]), fall);
    expect(exam.rule).toBe("inferred");
    expect(exam.date).toBe("2026-12-09");
    expect(exam.why).toContain("not printed");
  });

  test("an hour the table never prints falls to the catch-all", () => {
    const exam = examFor(section("ENG-2230-01", [meeting([2, 4], "19:00")]), fall);
    expect(exam).toMatchObject({ rule: "fallback", date: "2026-12-10", start: "15:30" });
  });

  test("online and graduate sections are left alone", () => {
    expect(examFor(section("BTGE-1725-OL", []), fall).rule).toBe("none");
    const graduate = examFor(section("BTAT-6410-01", [meeting([1, 3, 5], "09:00")]), fall);
    expect(graduate.rule).toBe("none");
    expect(graduate.why).toContain("graduate");
  });
});
