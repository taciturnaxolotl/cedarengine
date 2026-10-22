import { beforeEach, describe, expect, test } from "bun:test";
import { fileCrawl } from "../src/collect/catalog";
import { planCatalog } from "../src/collect/plan";
import { useDatabase } from "../src/db";
import { errorResponse } from "../src/lib/http";
import { syncRoutes } from "../src/routes/sync";
import type { RouteRequest } from "../src/routes/types";
import { searchSections, termStats } from "../src/store/catalog";
import { recentSweeps } from "../src/store/history";

const october = new Date("2026-10-22T12:00:00Z");

const section = (id: string) => ({ Id: id, CourseId: `c${id}`, SectionNameDisplay: `EGCP-${id}` });
const course = (id: string, code = id) => ({ Id: id, SubjectCode: "EGCP", Number: code });

/** Call a sync route the way the server would. */
async function post(path: string, payload: unknown) {
  const route = syncRoutes.find((r) => r.path === path && r.method === "POST")!;
  const request = new Request(`http://engine${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const response = await Promise.resolve()
    .then(() => route.handler(request as RouteRequest, new URL(request.url)))
    .catch((error: unknown) => errorResponse(error));
  return { status: response.status, body: (await response.json()) as any };
}

beforeEach(() => {
  useDatabase(":memory:");
});

describe("planning the catalog", () => {
  test("this term and the ones ahead, in order, past terms left alone", () => {
    const listed = ["2027SP", "2026SU", "2026FA", "2026SP", "2027SU", "2026FA"];
    expect(planCatalog(listed, october).terms).toEqual(["2026FA", "2027SP", "2027SU"]);
  });

  test("an unfamiliar code is skipped, not guessed", () => {
    expect(planCatalog(["2027WI", "CE2026", "2027SP"], october).terms).toEqual(["2027SP"]);
  });

  test("the every-course listing waits a week between crawls", () => {
    expect(planCatalog([], october).allCourses).toBe(true);
    fileCrawl("ALL", [], [course("1")], october.toISOString());
    expect(planCatalog([], october).allCourses).toBe(false);
    const nextWeek = new Date(october.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(planCatalog([], nextWeek).allCourses).toBe(true);
  });
});

describe("filing a crawl", () => {
  test("an empty term keeps the timetable it already had", () => {
    fileCrawl("2026FA", [section("1"), section("2")], [course("1")]);
    expect(fileCrawl("2026FA", [], [course("1")]).sections).toBe(0);
    expect(searchSections({ term: "2026FA" })).toHaveLength(2);
  });

  test("a new crawl drops a cancelled section", () => {
    fileCrawl("2026FA", [section("1"), section("2")], [], "2026-10-01T00:00:00.000Z");
    fileCrawl("2026FA", [section("1")], [], "2026-10-02T00:00:00.000Z");
    expect(searchSections({ term: "2026FA" }).map((s) => s.sectionId)).toEqual(["1"]);
  });

  test("the every-course listing holds one record per code", () => {
    expect(fileCrawl("ALL", [], [course("1", "1010"), course("2", "1010")]).courses).toBe(1);
  });
});

describe("the extension's catalog sweep", () => {
  test("start, one post per term, then close it complete", async () => {
    const start = await post("/v1/sync/start", { kind: "catalog", listed: ["2026FA", "2099SP"] });
    expect(start.body.kind).toBe("catalog");
    expect(start.body.terms).toContain("2099SP");
    const { sweep } = start.body;

    const filed = await post("/v1/sync/catalog", {
      sweep,
      term: "2099SP",
      sections: [section("1")],
      courses: [course("1")],
    });
    expect(filed.body).toMatchObject({ term: "2099SP", sections: 1, courses: 1, kept: false });

    await post("/v1/sync/catalog", { sweep, done: true, failed: [] });
    expect(recentSweeps(1)[0]).toMatchObject({
      kind: "catalog",
      source: "extension",
      complete: 1,
      seen: 2,
    });
    expect(termStats().map((t) => t.term)).toContain("2099SP");
  });

  test("an empty term is reported as kept, and failures leave the sweep partial", async () => {
    const { body } = await post("/v1/sync/start", { kind: "catalog", listed: ["2099SP"] });
    const empty = await post("/v1/sync/catalog", { sweep: body.sweep, term: "2099SP" });
    expect(empty.body.kept).toBe(true);

    await post("/v1/sync/catalog", { sweep: body.sweep, done: true, failed: ["2099SP"] });
    const [sweep] = recentSweeps(1);
    expect(sweep?.complete).toBe(0);
    expect(sweep?.note).toBe("failed: 2099SP");
  });

  test("a post with no term is refused", async () => {
    const { status } = await post("/v1/sync/catalog", { sections: [] });
    expect(status).toBe(400);
  });
});
