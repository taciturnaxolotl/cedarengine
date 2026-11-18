import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { auditLog } from "../src/auth/audit";
import { forgetIndikoCache } from "../src/auth/indiko";
import { setMasks } from "../src/auth/masks";
import type { Role } from "../src/auth/roles";
import { createToken, revokeToken } from "../src/auth/tokens";
import { useDatabase } from "../src/db";
import { upsertPeople } from "../src/store/people";
import { call } from "./call";

const ENV_TOKEN = process.env.BEARER_TOKEN!;
const PUBLIC_URL = "https://cedarengine.test";
const INDIKO = "https://indiko.test";

const mint = (role: Role, canary = false) => createToken(`${role} test`, role, { canary }).token;

beforeEach(() => {
  useDatabase(":memory:");
  upsertPeople(
    [
      {
        Id: "1",
        FirstName: "Ada",
        LastName: "Lovelace",
        DormName: "Printy Hall",
        DormRoom: "P101",
        StudentType: "UG",
        StudentClass: "FR",
      },
      {
        Id: "2",
        FirstName: "Grace",
        LastName: "Hopper",
        DormName: "Printy Hall",
        DormRoom: "P101",
        StudentType: "UG",
        StudentClass: "SO",
      },
    ],
    "2026-01-01T00:00:00.000Z",
  );
});

describe("authentication", () => {
  test("no token is a 401, the env token is admin", async () => {
    expect((await call("GET", "/v1/people")).status).toBe(401);
    expect((await call("GET", "/v1/people", "nope")).status).toBe(401);
    const me = await call("GET", "/v1/me", ENV_TOKEN);
    expect(me.body.role).toBe("admin");
    expect(me.body.actor).toBe("env");
  });

  test("a minted token works until it is revoked", async () => {
    const { token, record } = createToken("bot", "reader");
    expect((await call("GET", "/v1/people", token)).status).toBe(200);
    revokeToken(record.id);
    expect((await call("GET", "/v1/people", token)).status).toBe(401);
  });

  test("open routes need nothing", async () => {
    expect((await call("GET", "/health")).status).toBe(200);
    expect((await call("GET", "/oauth/web.json")).status).toBe(200);
  });
});

describe("roles", () => {
  test("a reader reads people but cannot write, sync or administer", async () => {
    const token = mint("reader");
    expect((await call("GET", "/v1/people/1", token)).status).toBe(200);
    expect((await call("GET", "/v1/stats", token)).status).toBe(403);
    expect((await call("GET", "/v1/admin/tokens", token)).status).toBe(403);
    expect((await call("GET", "/v1/sync/manifest", token)).status).toBe(403);
    const write = await call("POST", "/v1/people/1/facts", token, {
      source: "t",
      facts: [{ key: "k", value: "v" }],
    });
    expect(write.status).toBe(403);
  });

  test("an editor writes facts; a sync token syncs and sees nobody", async () => {
    const editor = mint("editor");
    const written = await call("POST", "/v1/people/1/facts", editor, {
      source: "t",
      facts: [{ key: "k", value: "v" }],
    });
    expect(written.status).toBe(200);
    const sync = mint("sync");
    expect((await call("GET", "/v1/sync/manifest", sync)).status).toBe(200);
    expect((await call("GET", "/v1/people", sync)).status).toBe(403);
  });
});

describe("masks", () => {
  test("limited by default: fields stripped, routes and filters refused", async () => {
    const token = mint("limited");
    const search = await call("GET", "/v1/people?q=Ada", token);
    const [ada] = search.body.people as Record<string, unknown>[];
    expect(ada?.firstName).toBe("Ada");
    expect(ada).not.toHaveProperty("dormName");
    expect(ada).not.toHaveProperty("dormRoom");
    expect((await call("GET", "/v1/people/1/roommates", token)).status).toBe(403);
    expect((await call("GET", "/v1/people?dorm=Printy%20Hall", token)).status).toBe(403);
    expect((await call("GET", "/v1/people?fact.x=1", token)).status).toBe(403);
  });

  test("an admin can lift a mask, and the change applies at once", async () => {
    const token = mint("limited");
    setMasks("limited", ["contact"]);
    const person = await call("GET", "/v1/people/1", token);
    expect(person.body.dormName).toBe("Printy Hall");
    expect((await call("GET", "/v1/people/1/roommates", token)).status).toBe(200);
  });

  test("mask edits go through the admin API, and admin itself cannot be masked", async () => {
    const set = await call("POST", "/v1/admin/roles/reader/masks", ENV_TOKEN, {
      masks: ["housing"],
    });
    expect(set.body.masks).toEqual(["housing"]);
    const reader = mint("reader");
    expect((await call("GET", "/v1/people/1", reader)).body).not.toHaveProperty("dormName");
    expect(
      (await call("POST", "/v1/admin/roles/admin/masks", ENV_TOKEN, { masks: ["housing"] })).status,
    ).toBe(400);
    expect(
      (await call("POST", "/v1/admin/roles/reader/masks", ENV_TOKEN, { masks: ["bogus"] })).status,
    ).toBe(400);
  });
});

describe("custom masks", () => {
  const create = (mask: Record<string, unknown>) =>
    call("POST", "/v1/admin/masks", ENV_TOKEN, { fields: [], routes: [], filters: [], ...mask });

  test("an admin composes one from known parts and gives it to a role", async () => {
    const made = await create({
      id: "dept",
      label: "Department",
      fields: ["department"],
      filters: ["department"],
    });
    expect(made.status).toBe(200);
    await call("POST", "/v1/admin/roles/reader/masks", ENV_TOKEN, { masks: ["dept"] });

    const reader = mint("reader");
    const person = await call("GET", "/v1/people/1", reader);
    expect(person.status).toBe(200);
    expect(person.body).not.toHaveProperty("department");
    expect(person.body.dormName).toBe("Printy Hall");
    expect((await call("GET", "/v1/people?department=x", reader)).status).toBe(403);
  });

  test("a field mask touches only people, never a course or exam with the same key", async () => {
    const { stripFields } = await import("../src/auth/masks");
    const response = {
      people: [{ id: "1", lastName: "Hopper", title: "Professor", firstSeen: "x", lastSeen: "y" }],
      sections: [{ title: "Calculus I", room: "ENS 101" }],
    };
    expect(stripFields(response, new Set(["title"]))).toEqual({
      people: [{ id: "1", lastName: "Hopper", firstSeen: "x", lastSeen: "y" }],
      sections: [{ title: "Calculus I", room: "ENS 101" }],
    });
  });

  test("hiding dormRoom also blanks the roommates room and suite", async () => {
    await create({ id: "room", label: "Room", fields: ["dormRoom"] });
    await call("POST", "/v1/admin/roles/reader/masks", ENV_TOKEN, { masks: ["room"] });
    const result = await call("GET", "/v1/people/1/roommates", mint("reader"));
    expect(result.status).toBe(200);
    expect(result.body.room).toBeNull();
    expect(result.body.suite).toBeNull();
    const [grace] = result.body.roommates as Record<string, unknown>[];
    expect(grace?.firstName).toBe("Grace");
    expect(grace).not.toHaveProperty("dormRoom");
  });

  test("hiding a field drops its changes from history, and leaves the rest", async () => {
    upsertPeople(
      [
        {
          Id: "1",
          FirstName: "Ada",
          LastName: "Lovelace",
          DormName: "Brock Hall",
          DormRoom: "B204",
          StudentType: "UG",
          StudentClass: "SO",
        },
      ],
      "2026-02-01T00:00:00.000Z",
    );
    await create({ id: "dorm", label: "Dorm", fields: ["dormName", "dormRoom"] });
    await call("POST", "/v1/admin/roles/reader/masks", ENV_TOKEN, { masks: ["dorm"] });
    const reader = mint("reader");

    const own = await call("GET", "/v1/people/1/history", reader);
    const changes = own.body.directory as { field: string | null }[];
    expect(changes.map((c) => c.field)).toEqual(expect.arrayContaining(["student_class"]));
    expect(changes.some((c) => c.field === "dorm_name" || c.field === "dorm_room")).toBe(false);

    const all = await call("GET", "/v1/history/events", reader);
    const events = all.body.events as { field: string | null }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.field === "dorm_name" || e.field === "dorm_room")).toBe(false);

    const admin = await call("GET", "/v1/people/1/history", ENV_TOKEN);
    expect((admin.body.directory as { field: string }[]).some((c) => c.field === "dorm_room")).toBe(
      true,
    );
  });

  test("unknown parts, built-in ids, empty masks and catalog routes are refused", async () => {
    expect((await create({ id: "a1", label: "x", fields: ["ssn"] })).status).toBe(400);
    expect((await create({ id: "housing", label: "x", fields: ["email"] })).status).toBe(400);
    expect((await create({ id: "empty", label: "x" })).status).toBe(400);
    expect((await create({ id: "terms", label: "x", routes: ["/v1/terms"] })).status).toBe(400);
    expect((await create({ id: "Bad Id", label: "x", fields: ["email"] })).status).toBe(400);
    expect((await create({ id: "ok", label: "x", fields: ["id"] })).status).toBe(400);
  });

  test("a mask still in use cannot be deleted, so deleting never unhides anything", async () => {
    await create({ id: "dept", label: "Department", fields: ["department"] });
    await call("POST", "/v1/admin/roles/reader/masks", ENV_TOKEN, { masks: ["dept"] });
    expect((await call("POST", "/v1/admin/masks/dept/delete", ENV_TOKEN)).status).toBe(400);
    await call("POST", "/v1/admin/roles/reader/masks", ENV_TOKEN, { masks: [] });
    expect((await call("POST", "/v1/admin/masks/dept/delete", ENV_TOKEN)).status).toBe(200);
    const builtin = await call("POST", "/v1/admin/masks/housing/delete", ENV_TOKEN);
    expect(builtin.body.error).toBe("built-in masks cannot be deleted");
    expect((await call("POST", "/v1/admin/masks/nope/delete", ENV_TOKEN)).status).toBe(404);
  });
});

describe("audit log", () => {
  test("records who asked for which path, and never a query token", async () => {
    const { token, record } = createToken("bot", "reader");
    await call("GET", "/v1/people/1", token);
    await call("GET", "/v1/people/2/photo?token=secret-value", ENV_TOKEN);
    const { rows } = auditLog();
    expect(rows.map((r) => [r.actor, r.path, r.status])).toEqual([
      ["env", "/v1/people/2/photo?token=[redacted]", 404],
      [`token:${record.id}`, "/v1/people/1", 200],
    ]);
    expect(auditLog({ path: "/people/1" }).total).toBe(1);
  });

  test("unauthenticated requests are not audited, only counted", async () => {
    await call("GET", "/v1/people");
    expect(auditLog().total).toBe(0);
  });
});

describe("canary tokens", () => {
  test("person routes answer with stable decoys and every hit is flagged", async () => {
    const token = mint("reader", true);
    const first = await call("GET", "/v1/people?q=Lovelace", token);
    const again = await call("GET", "/v1/people?q=Lovelace", token);
    const people = first.body.people as Record<string, unknown>[];
    expect(people.length).toBeGreaterThan(0);
    expect(people.every((p) => p.lastName === "Lovelace" && p.id !== "1")).toBe(true);
    expect(again.body).toEqual(first.body);

    const ada = await call("GET", "/v1/people/1", token);
    expect(ada.body.firstName).not.toBe("Ada");
    expect((await call("GET", "/v1/people/1/schedule", token)).status).toBe(404);
    expect(auditLog({ canary: true }).total).toBe(4);
  });

  test("catalog routes answer for real", async () => {
    const token = mint("reader", true);
    expect((await call("GET", "/v1/terms", token)).status).toBe(200);
  });
});

describe("indiko tokens", () => {
  const realFetch = globalThis.fetch;
  let reply: Record<string, unknown>;
  let calls = 0;

  beforeEach(() => {
    process.env.INDIKO_URL = INDIKO;
    process.env.PUBLIC_URL = PUBLIC_URL;
    forgetIndikoCache();
    calls = 0;
    reply = {
      active: true,
      sub: `${INDIKO}/u/kieran`,
      username: "kieran",
      client_id: `${PUBLIC_URL}/oauth/ios.json`,
      aud: PUBLIC_URL,
      role: "reader",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      calls++;
      expect(String(input)).toBe(`${INDIKO}/auth/token/introspect`);
      return Response.json(reply);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.INDIKO_URL;
    delete process.env.PUBLIC_URL;
  });

  test("a token for this audience signs in with indiko's role, and is cached", async () => {
    const me = await call("GET", "/v1/me", "indiko-opaque");
    expect(me.body).toMatchObject({
      actor: `indiko:${INDIKO}/u/kieran`,
      name: "kieran",
      role: "reader",
      client: `${PUBLIC_URL}/oauth/ios.json`,
    });
    await call("GET", "/v1/people", "indiko-opaque");
    expect(calls).toBe(1);
  });

  test("a token minted for another audience, or none, is refused", async () => {
    reply.aud = "https://other.test";
    expect((await call("GET", "/v1/me", "for-someone-else")).status).toBe(401);
    delete reply.aud;
    expect((await call("GET", "/v1/me", "unscoped")).status).toBe(401);
  });

  test("an unknown or missing role is refused, an inactive token too", async () => {
    reply.role = "owner";
    expect((await call("GET", "/v1/me", "odd-role")).status).toBe(401);
    delete reply.role;
    expect((await call("GET", "/v1/me", "no-role")).status).toBe(401);
    reply = { active: false };
    expect((await call("GET", "/v1/me", "dead")).status).toBe(401);
  });

  test("a refusal says why, so the sign-in page can explain it", async () => {
    delete reply.role;
    expect((await call("GET", "/v1/me", "roleless")).body.error).toContain(
      "indiko reports no role for you",
    );
    reply.role = "Admin";
    expect((await call("GET", "/v1/me", "capitalised")).body.error).toContain('the role "Admin"');
    reply.role = "reader";
    reply.aud = "https://other.test";
    expect((await call("GET", "/v1/me", "elsewhere")).body.error).toContain(
      "is for https://other.test",
    );
    delete reply.aud;
    expect((await call("GET", "/v1/me", "unscoped-2")).body.error).toContain(
      "was not requested for",
    );
  });

  test("the protected resource document points at indiko", async () => {
    const prm = await call("GET", "/.well-known/oauth-protected-resource");
    expect(prm.body.resource).toBe(PUBLIC_URL);
    expect(prm.body.authorization_servers).toEqual([INDIKO]);
  });
});
