import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  crawlBook,
  graduateSpans,
  graduateTitle,
  mergePrograms,
  type ProgramPage,
  parseToc,
  spanText,
  type TocEntry,
} from "../src/collect/book";
import { useDatabase } from "../src/db";
import { editionFor, forgetModel, model } from "../src/model/major";
import { forgetSchools, schoolOf } from "../src/store/majors";
import { listPrograms, programByPage, programYears, replaceYear } from "../src/store/programs";

// A miniature of the graduate contents: front matter, a school with two
// degrees and a subsection, a page shared by two combined degrees, a faculty
// list, and the course descriptions that end the program section.
const TOC: TocEntry[] = [
  { page: 2, title: "Master of Nothing In Particular" },
  { page: 26, title: "Academic Schools" },
  { page: 38, title: "Cedarville Theological Seminary" },
  { page: 39, title: "Master of Divinity" },
  { page: 39, title: "Program Delivery" },
  { page: 43, title: "Accelerated Master of Divinity" },
  { page: 47, title: "Master of Arts in Worship and Theology (In Teach-Out)" },
  { page: 56, title: "Cedarville Theological Seminary Faculty" },
  { page: 57, title: "Robert W. Plaster School of Business" },
  { page: 68, title: "Combined Degree Programs" },
  { page: 68, title: "MBA/MDiv Combined Degree Course Requirements" },
  { page: 68, title: "PharmD/MBA Combined Degree Course Requirements" },
  { page: 76, title: "School of Nursing" },
  { page: 77, title: "Doctor of Nursing Practice Pathways" },
  { page: 90, title: "MSN – Family Nurse Practitioner Track" },
  { page: 111, title: "Graduate-Level Course Descriptions" },
  { page: 123, title: "Master Physician Assistant Studies (MPAS)" },
];

const tocHtml = (entries: TocEntry[]) =>
  `<table>${entries
    .map(
      (e) =>
        `<tr><td> <a class="internalLink" href="../${e.page}/">${e.title} </a> </td><td>${e.page}</td></tr>`,
    )
    .join("")}<a href="../148/">148</a></table>`;

describe("the graduate contents", () => {
  test("parse into headings, dropping the page-number links", () => {
    const entries = parseToc(tocHtml(TOC.slice(0, 3)));
    expect(entries).toEqual(TOC.slice(0, 3));
  });

  test("cut into one span per program, inside the program section only", () => {
    const spans = graduateSpans(TOC);
    expect(spans.map((s) => [s.title, s.start, s.end])).toEqual([
      ["Master of Divinity", 39, 42],
      ["Accelerated Master of Divinity", 43, 46],
      ["Master of Arts in Worship and Theology", 47, 55],
      ["MBA/MDiv Combined Degree", 68, 68],
      ["PharmD/MBA Combined Degree", 68, 75],
      ["MSN, Family Nurse Practitioner", 90, 110],
    ]);
  });

  test("file each program under the school printed above it", () => {
    const schools = Object.fromEntries(graduateSpans(TOC).map((s) => [s.title, s.school]));
    expect(schools["Master of Divinity"]).toBe("School of Biblical and Theological Studies");
    expect(schools["PharmD/MBA Combined Degree"]).toBe("Robert W. Plaster School of Business");
    expect(schools["MSN, Family Nurse Practitioner"]).toBe("School of Nursing");
  });

  test("a program sharing its page is cut at the next heading", () => {
    const [mdiv] = graduateSpans(TOC).filter((s) => s.start === 68);
    const pages = new Map([
      [
        68,
        "Combined Degree Programs MBA/MDiv Combined Degree Course Requirements BUS-6010 BTAT-6410 " +
          "PharmD/MBA Combined Degree Course Requirements PHAR-7010",
      ],
    ]);
    const text = spanText(mdiv!, pages);
    expect(text).toContain("BTAT-6410");
    expect(text).not.toContain("PHAR-7010");
  });

  test("headings read the way the registrar writes them", () => {
    expect(graduateTitle("Doctor of Nursing Practice Program: BSN entry to DNP")).toBe(
      "Doctor of Nursing Practice, BSN entry to DNP",
    );
    expect(graduateTitle("Doctor of Nursing Practice Program")).toBe("Doctor of Nursing Practice");
    expect(graduateTitle("MSN – Nurse Educator Track")).toBe("MSN, Nurse Educator");
  });

  test("a combined degree printed under two schools is one program", () => {
    const page = (courses: string[]): ProgramPage => ({
      page: 1,
      title: "MBA/MDiv Combined Degree",
      summary: [],
      doubleCounts: [],
      sequence: [],
      courses,
    });
    const merged = mergePrograms([page(["BUS-6010"]), page(["BTAT-6410"])]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.courses).toEqual(["BTAT-6410", "BUS-6010"]);
  });
});

describe("crawling the graduate book", () => {
  test("fetches only the pages inside a program and reads them", async () => {
    const asked: string[] = [];
    const pages: Record<number, string> = {
      39: "Master of Divinity Course Requirements BTAT-6410 BTHT-6100 Summary Core.......30 Total.......79",
      43: "Accelerated Master of Divinity BTAT-6510",
    };
    const fake = async (url: string) => {
      asked.push(url);
      if (url.endsWith("/toc/")) return new Response(tocHtml(TOC.slice(1, 6)));
      const page = Number(url.match(/\/(\d+)\/$/)?.[1]);
      return new Response(`<p>${pages[page] ?? "no codes here"}</p>`);
    };
    const book = await crawlBook("2026-2027", {
      edition: "graduate",
      delayMs: 0,
      fetch: fake as unknown as typeof fetch,
    });
    expect(asked.every((u) => u.includes("/academiccatalogs/graduate/2026-2027/"))).toBe(true);
    expect(asked.some((u) => u.endsWith("/2/"))).toBe(false);
    expect(book.programs.map((p) => [p.title, p.courses])).toEqual([
      ["Master of Divinity", ["BTAT-6410", "BTHT-6100"]],
      ["Accelerated Master of Divinity", ["BTAT-6510"]],
    ]);
    expect(book.programs[0]?.summary.at(-1)).toEqual({ label: "Total", min: 79, max: 79 });
  });

  test("a year without a graduate book says so", async () => {
    const fake = async () => new Response("", { status: 404 });
    await expect(
      crawlBook("1999-2000", { edition: "graduate", fetch: fake as unknown as typeof fetch }),
    ).rejects.toThrow("no graduate catalog");
  });
});

const program = (page: number, title: string, courses: string[], school?: string) => ({
  page,
  title,
  summary: [],
  doubleCounts: [],
  sequence: [],
  courses,
  school,
});

describe("both editions in one year", () => {
  beforeEach(() => {
    useDatabase(":memory:");
    forgetModel();
    forgetSchools();
  });

  test("share page numbers without colliding", () => {
    const at = new Date().toISOString();
    replaceYear("2026-2027", [program(40, "Nursing", ["NSG-1000"])], at);
    replaceYear(
      "2026-2027",
      [
        program(
          40,
          "Master of Divinity",
          ["BTAT-6410"],
          "School of Biblical and Theological Studies",
        ),
      ],
      at,
      "graduate",
    );
    expect(programByPage("2026-2027", 40)?.title).toBe("Nursing");
    expect(programByPage("2026-2027", 40, "graduate")?.title).toBe("Master of Divinity");
    expect(listPrograms("2026-2027")).toHaveLength(2);
    expect(listPrograms("2026-2027", undefined, "graduate")).toHaveLength(1);
    expect(programYears()[0]?.editions).toEqual({ undergraduate: 1, graduate: 1 });
  });

  test("replacing one edition leaves the other alone", () => {
    replaceYear("2026-2027", [program(40, "Nursing", ["NSG-1000"])], "2026-01-01T00:00:00Z");
    replaceYear(
      "2026-2027",
      [program(40, "Master of Divinity", ["BTAT-6410"])],
      "2026-02-01T00:00:00Z",
      "graduate",
    );
    expect(listPrograms("2026-2027").map((p) => p.title)).toEqual([
      "Master of Divinity",
      "Nursing",
    ]);
  });

  test("a seminary booklist is read against the seminary", () => {
    const at = new Date().toISOString();
    replaceYear("2026-2027", [program(40, "Nursing", ["NSG-1000"])], at);
    replaceYear(
      "2026-2027",
      [
        program(
          40,
          "Master of Divinity",
          ["BTAT-6410"],
          "School of Biblical and Theological Studies",
        ),
      ],
      at,
      "graduate",
    );
    expect(model("2026-2027").guess(["BTAT-6410"]).ranked[0]?.title).toBe("Master of Divinity");
    expect(schoolOf("Master of Divinity")).toBe("School of Biblical and Theological Studies");
  });
});

describe("a database from before editions", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cedarengine-"));
  });
  afterEach(() => {
    useDatabase(":memory:");
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps its programs as the undergraduate edition", () => {
    const path = join(dir, "old.db");
    const old = new Database(path);
    old.exec(`CREATE TABLE programs (
      year TEXT NOT NULL, page INTEGER NOT NULL, title TEXT NOT NULL, total_credits REAL,
      courses TEXT NOT NULL, payload TEXT NOT NULL, fetched_at TEXT NOT NULL,
      PRIMARY KEY (year, page)) STRICT`);
    old
      .query("INSERT INTO programs VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        "2026-2027",
        216,
        "Biblical and Theological Studies",
        126,
        '["BTAT-3200"]',
        JSON.stringify(program(216, "Biblical and Theological Studies", ["BTAT-3200"])),
        "2026-08-12T00:00:00Z",
      );
    old.close();

    useDatabase(path);
    const kept = programByPage("2026-2027", 216);
    expect(kept?.title).toBe("Biblical and Theological Studies");
    expect(kept?.edition).toBe("undergraduate");
    // And opening it again is a no-op rather than a second migration.
    useDatabase(path);
    expect(listPrograms("2026-2027")).toHaveLength(1);
  });
});

describe("choosing the book", () => {
  test("mostly graduate-level courses read against the graduate book", () => {
    expect(editionFor(["BTAT-6410", "BTHT-6100", "BTGE-1200"])).toBe("graduate");
    expect(editionFor(["BTAT-6410", "BTGE-1200"])).toBe("undergraduate");
    expect(editionFor(["PHAR-7010"])).toBe("graduate");
    expect(editionFor([])).toBe("undergraduate");
  });

  test("graduate programs do not rerank an undergraduate", () => {
    useDatabase(":memory:");
    forgetModel();
    const at = new Date().toISOString();
    const undergrad = [
      program(1, "Marketing", ["BUS-1000", "MKT-2000", "GSS-1100"]),
      program(2, "Social Work", ["SWK-2000", "GSS-1100", "PSY-1600"]),
    ];
    replaceYear("2026-2027", undergrad, at);
    const before = model("2026-2027").guess(["SWK-2000", "BUS-1000", "GSS-1100"]).ranked;
    replaceYear(
      "2026-2027",
      [program(1, "Master of Business Administration", ["BUS-6010", "BUS-1000"])],
      at,
      "graduate",
    );
    forgetModel();
    expect(model("2026-2027").guess(["SWK-2000", "BUS-1000", "GSS-1100"]).ranked).toEqual(before);
  });
});
