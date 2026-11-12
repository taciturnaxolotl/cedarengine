import { beforeEach, describe, expect, test } from "bun:test";
import { planDetails } from "../src/collect/plan";
import { db, useDatabase } from "../src/db";
import { errorResponse } from "../src/lib/http";
import { syncRoutes } from "../src/routes/sync";
import type { RouteRequest } from "../src/routes/types";
import { markNoDetails, putDetails } from "../src/store/details";
import { personTimeline, recentSweeps } from "../src/store/history";
import { personById, searchPeople, upsertPeople } from "../src/store/people";

const person = (id: string, over: Record<string, unknown> = {}) => ({
  Id: id,
  Username: "AdaLovelace",
  FirstName: "Ada",
  LastName: "Lovelace",
  StudentType: "UG",
  StudentClass: "FR",
  ...over,
});

const details = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  reunionClass: "2030",
  poBox: "4102",
  ...over,
});

const changes = (id: string) => personTimeline(id).filter((event) => event.kind === "changed");

beforeEach(() => {
  useDatabase(":memory:");
});

describe("what a person's own page adds", () => {
  test("the email is the username's, and the rest is unknown until asked", () => {
    upsertPeople([person("1")]);
    expect(personById("1")).toMatchObject({
      email: "adalovelace@cedarville.edu",
      reunionClass: null,
      poBox: null,
    });
  });

  test("once fetched, the page's own answers are what a person carries", () => {
    upsertPeople([person("1")]);
    putDetails([details("1")]);

    expect(personById("1")).toMatchObject({
      email: "adalovelace@cedarville.edu",
      reunionClass: "2030",
      poBox: "4102",
    });
    expect(searchPeople({})[0]).toMatchObject({ reunionClass: "2030", poBox: "4102" });
  });

  test("an empty string is no value, not a value", () => {
    upsertPeople([person("1")]);
    putDetails([details("1", { poBox: "", reunionClass: "  " })]);
    expect(personById("1")).toMatchObject({ reunionClass: null, poBox: null });
  });

  test("a directory sweep does not take the details with it", () => {
    upsertPeople([person("1")]);
    putDetails([details("1")]);
    upsertPeople([person("1", { StudentClass: "SO" })]);
    expect(personById("1")).toMatchObject({ studentClass: "SO", poBox: "4102" });
  });

  test("the first answer is not a change", () => {
    upsertPeople([person("1")]);
    expect(putDetails([details("1")])).toEqual({ stored: 1, changed: 0, unchanged: 0 });
    expect(changes("1")).toHaveLength(0);
  });

  test("a new mailbox is recorded with both sides of it", () => {
    upsertPeople([person("1")]);
    putDetails([details("1")], "2026-05-01T00:00:00.000Z");
    const tally = putDetails([details("1", { poBox: "5518" })], "2026-08-20T00:00:00.000Z");

    expect(tally).toEqual({ stored: 0, changed: 1, unchanged: 0 });
    expect(changes("1")).toHaveLength(1);
    expect(changes("1")[0]).toMatchObject({ field: "po_box", was: "4102", now: "5518" });
  });

  test("falling a year behind moves the reunion class, and says so", () => {
    upsertPeople([person("1")]);
    putDetails([details("1")]);
    putDetails([details("1", { reunionClass: "2031" })]);
    expect(changes("1")[0]).toMatchObject({ field: "reunion_class", was: "2030", now: "2031" });
  });

  test("asking again and hearing the same thing writes nothing down", () => {
    upsertPeople([person("1")]);
    putDetails([details("1")]);
    expect(putDetails([details("1")])).toEqual({ stored: 0, changed: 0, unchanged: 1 });
    expect(changes("1")).toHaveLength(0);
  });

  test("one refusal does not erase what was known", () => {
    upsertPeople([person("1")]);
    putDetails([details("1")]);
    markNoDetails("1");
    expect(personById("1")?.poBox).toBe("4102");
  });

  test("people can be found by reunion class", () => {
    upsertPeople([person("1"), person("2", { Username: "GraceHopper", LastName: "Hopper" })]);
    putDetails([details("1"), details("2", { reunionClass: "2028" })]);
    expect(searchPeople({ reunion: "2028" }).map((p) => p.id)).toEqual(["2"]);
  });
});

describe("planning the details sweep", () => {
  test("everyone still listed is asked about once, the never-asked first", () => {
    upsertPeople([
      person("1", { LastName: "Zuse" }),
      person("2", { LastName: "Babbage" }),
      person("3", { LastName: "Hopper" }),
    ]);
    expect(planDetails().ids).toEqual(["2", "3", "1"]);

    putDetails([details("2")]);
    markNoDetails("3");
    expect(planDetails()).toEqual({ remaining: 1, ids: ["1"] });
  });

  test("an old answer comes back around, behind anyone never asked", () => {
    upsertPeople([person("1", { LastName: "Zuse" }), person("2", { LastName: "Babbage" })]);
    putDetails([details("2")], "2020-01-01T00:00:00.000Z");
    expect(planDetails().ids).toEqual(["1", "2"]);
  });

  test("the departed are left alone", () => {
    upsertPeople([person("1")]);
    db().query("UPDATE people SET present = 0 WHERE id = ?").run("1");
    expect(planDetails().remaining).toBe(0);
  });
});

async function call(path: string, payload: unknown) {
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

describe("the details sweep over HTTP", () => {
  test("a batch is filed, the misses shelved, and the sweep closes once nobody is left", async () => {
    upsertPeople([person("1"), person("2", { LastName: "Hopper" })]);
    const start = await call("/v1/sync/start", { kind: "details" });
    expect(start.body.ids).toEqual(["2", "1"]);

    const posted = await call("/v1/sync/details", {
      sweep: start.body.sweep,
      rows: [details("1")],
      missed: ["2"],
    });
    expect(posted.body).toMatchObject({ stored: 1, missed: 1, remaining: 0, done: true });
    expect(personById("1")?.poBox).toBe("4102");

    const sweep = recentSweeps().find((s) => s.id === start.body.sweep);
    expect(sweep).toMatchObject({ kind: "details", complete: 1, seen: 2, added: 1 });
  });

  test("a body that is not a batch is turned away", async () => {
    const posted = await call("/v1/sync/details", { rows: {}, missed: [] });
    expect(posted.status).toBe(400);
  });
});
