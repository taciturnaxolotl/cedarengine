import { beforeEach, describe, expect, test } from "bun:test";
import { useDatabase } from "../src/db";
import { currentTerm } from "../src/lib/terms";
import { clusterOf } from "../src/model/clusters";
import { buildModel, forgetModel } from "../src/model/major";
import { forgetSchools, replaceMajors, schoolOf } from "../src/store/majors";
import { replaceYear } from "../src/store/programs";

const page = (title: string, courses: string[], at = 1) => ({
  page: at,
  title,
  summary: [{ label: "Total", min: 128, max: 128 }],
  doubleCounts: [],
  sequence: [],
  courses,
});

// Two engineering programs sharing a freshman core, and one that shares
// nothing but the gen-eds. This is the situation the weighting exists for.
const GEN_ED = ["BTGE-1200", "GSS-1100", "ENG-1400"];

beforeEach(() => {
  useDatabase(":memory:");
  forgetModel();
  replaceYear(
    "2026-2027",
    [
      page("Computer Engineering", [...GEN_ED, "MATH-1710", "EGCP-1010", "EGCP-2020"], 1),
      page("Electrical Engineering", [...GEN_ED, "MATH-1710", "EGEE-2010", "EGEE-3010"], 2),
      page("Biblical Studies", [...GEN_ED, "BEGE-2200", "BTGE-3300"], 3),
    ],
    new Date().toISOString(),
  );
});

describe("the major model", () => {
  test("gen-eds alone say nothing", () => {
    const { ranked, signal } = buildModel("2026-2027").guess(GEN_ED);
    expect(signal).toBe(0);
    // Every program shares them, so no program is meaningfully ahead.
    const spread = (ranked[0]?.score ?? 0) - (ranked.at(-1)?.score ?? 0);
    expect(spread).toBeLessThan(0.35);
  });

  test("one distinctive course names the program", () => {
    const { ranked } = buildModel("2026-2027").guess([...GEN_ED, "EGEE-3010"]);
    expect(ranked[0]?.title).toBe("Electrical Engineering");
  });

  test("signal is measured against a real catalog, not a toy one", () => {
    // The threshold is tuned for the ~79 programs the book actually holds. In a
    // three-program corpus nothing is rare enough to clear it, which is the
    // right answer: with three programs, no course is distinctive.
    const { signal } = buildModel("2026-2027").guess([...GEN_ED, "EGEE-3010"]);
    expect(signal).toBe(0);
  });

  test("an empty booklist ranks nothing rather than guessing", () => {
    expect(buildModel("2026-2027").guess([]).ranked).toEqual([]);
  });

  test("courses the catalog has never heard of rank nothing rather than catalog order", () => {
    const { ranked } = buildModel("2026-2027").guess(["ZZZZ-9999"]);
    expect(ranked).toEqual([]);
  });

  test("programs sharing nothing with the booklist are left out", () => {
    const { ranked } = buildModel("2026-2027").guess(["EGEE-3010"]);
    expect(ranked.map((g) => g.title)).toEqual(["Electrical Engineering"]);
  });
});

describe("clusters", () => {
  test("collapse the distinctions a booklist cannot carry", () => {
    expect(clusterOf("Computer Engineering")).toBe(clusterOf("Electrical Engineering"));
    expect(clusterOf("Computer Engineering")).not.toBe(clusterOf("Biblical Studies"));
  });

  test("an unlabelled student has no cluster at all", () => {
    expect(clusterOf("")).toBe("");
  });
});

describe("terms", () => {
  test("the academic year turns over in August", () => {
    expect(currentTerm(new Date("2026-08-20"))).toBe("2026FA");
    expect(currentTerm(new Date("2027-02-01"))).toBe("2027SP");
    expect(currentTerm(new Date("2027-06-01"))).toBe("2027SU");
  });
});

describe("the registrar's taxonomy", () => {
  test("a book title finds its school despite the degree suffix", () => {
    replaceMajors([
      { program: "Chemistry", level: "major", department: "Science", school: "Science and Maths" },
      { program: "Computer Engineering", level: "major", department: "ECS", school: "Engineering" },
    ]);
    forgetSchools();

    expect(schoolOf("Chemistry — BA")).toBe("Science and Maths");
    expect(schoolOf("Chemistry — BS")).toBe("Science and Maths");
    expect(schoolOf("Computer Engineering")).toBe("Engineering");
    expect(clusterOf("Chemistry — BS")).toBe("Science and Maths");
  });

  test("a program the taxonomy never heard of falls back to the patterns", () => {
    replaceMajors([
      { program: "Chemistry", level: "major", department: "Science", school: "Science and Maths" },
    ]);
    forgetSchools();

    expect(schoolOf("Underwater Basket Weaving")).toBeNull();
    expect(clusterOf("Mechanical Engineering")).toBe("Engineering / CS");
    expect(clusterOf("")).toBe("");
  });
});
