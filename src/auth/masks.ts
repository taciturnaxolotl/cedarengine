/**
 * What a role may not see.
 *
 * A mask is a named group of person fields, whole routes and query filters
 * that travel together: hiding someone's dorm means hiding the dorm fields,
 * the roommates route and the ability to search by dorm, or the mask leaks
 * through the side door. The built-in groups live here; admins can compose
 * more from the same parts, but only from parts the engine knows exist, so a
 * typo can never produce a mask that hides nothing. Admin is never masked.
 */

import { db } from "../db";
import type { Person } from "../store/people";
import { ROLES, type Role } from "./roles";

interface MaskGroup {
  label: string;
  fields: readonly string[];
  routes: readonly string[];
  filters: readonly string[];
}

export interface Mask extends MaskGroup {
  id: string;
  builtin: boolean;
}

/** Every field of a person, spelled out so adding a column forces a decision here. */
const PERSON_FIELD_SET: Record<keyof Person, true> = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  middleName: true,
  nickname: true,
  city: true,
  state: true,
  country: true,
  department: true,
  title: true,
  officeCode: true,
  officeName: true,
  officeRoom: true,
  officePhone: true,
  dormCode: true,
  dormName: true,
  dormRoom: true,
  studentType: true,
  studentClass: true,
  studentWorker: true,
  empInactive: true,
  photoUrl: true,
  email: true,
  reunionClass: true,
  poBox: true,
  present: true,
  firstSeen: true,
  lastSeen: true,
};
/** The id stays visible: without it nothing else can be addressed. `present` is never selected. */
export const PERSON_FIELDS = Object.keys(PERSON_FIELD_SET).filter(
  (field) => field !== "id" && field !== "present",
);

const maskable = {
  routes: [] as string[],
  filters: [] as string[],
  routeFilters: {} as Record<string, string[]>,
};

/** Called once the route table exists: the routes and filters a mask may hide. */
export function registerMaskable(routes: { path: string; query?: { name: string }[] }[]): void {
  const routeFilters: Record<string, string[]> = {};
  for (const route of routes) {
    const names = (route.query ?? [])
      .map((param) => param.name)
      .filter((name) => name !== "limit" && name !== "offset");
    routeFilters[route.path] = [...new Set([...(routeFilters[route.path] ?? []), ...names])];
  }
  maskable.routeFilters = routeFilters;
  maskable.routes = Object.keys(routeFilters).sort();
  maskable.filters = [...new Set(Object.values(routeFilters).flat())].sort();
}

/** The flat lists validate a mask; routeFilters says where each filter lives, for the tree. */
export const maskableParts = () => ({
  fields: PERSON_FIELDS,
  routes: maskable.routes,
  filters: maskable.filters,
  routeFilters: maskable.routeFilters,
});

export const BUILTIN_MASKS = {
  contact: {
    label: "Email, username, office phone and PO box",
    fields: ["email", "username", "officePhone", "poBox"],
    routes: [],
    filters: [],
  },
  housing: {
    label: "Dorm, room, roommates and mapped location",
    fields: ["dormCode", "dormName", "dormRoom"],
    routes: ["/v1/people/:id/roommates", "/v1/people/:id/location", "/v1/dorms"],
    filters: ["dorm"],
  },
  hometown: {
    label: "City, state and country",
    fields: ["city", "state", "country"],
    routes: [],
    filters: [],
  },
  photo: {
    label: "Directory photos",
    fields: ["photoUrl"],
    routes: ["/v1/people/:id/photo"],
    filters: [],
  },
  schedule: {
    label: "Class schedules and exams",
    fields: [],
    routes: ["/v1/people/:id/schedule", "/v1/people/:id/exams"],
    filters: [],
  },
  majors: {
    label: "Inferred majors",
    fields: [],
    routes: ["/v1/people/:id/major", "/v1/majors/guesses"],
    filters: [],
  },
  facts: {
    label: "Facts",
    fields: [],
    routes: ["/v1/people/:id/facts", "/v1/facts", "/v1/facts/keys"],
    filters: ["fact.*", "has"],
  },
  history: {
    label: "Directory and booklist history",
    fields: [],
    routes: ["/v1/people/:id/history", "/v1/history/events"],
    filters: [],
  },
} as const satisfies Record<string, MaskGroup>;

interface CustomRow {
  id: string;
  label: string;
  fields: string;
  routes: string;
  filters: string;
}

export function allMasks(): Mask[] {
  const builtin = Object.entries(BUILTIN_MASKS).map(([id, group]) => ({
    id,
    ...(group as MaskGroup),
    builtin: true,
  }));
  const custom = db()
    .query<CustomRow, []>("SELECT * FROM custom_masks ORDER BY id")
    .all()
    .map((row) => ({
      id: row.id,
      label: row.label,
      fields: JSON.parse(row.fields) as string[],
      routes: JSON.parse(row.routes) as string[],
      filters: JSON.parse(row.filters) as string[],
      builtin: false,
    }));
  return [...builtin, ...custom];
}

export const isMask = (value: unknown): value is string =>
  typeof value === "string" && allMasks().some((mask) => mask.id === value);

/** Validate a mask an admin composed. Returns the problem, or null. */
export function checkCustomMask(mask: {
  id?: unknown;
  label?: unknown;
  fields?: unknown;
  routes?: unknown;
  filters?: unknown;
}): string | null {
  if (typeof mask.id !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(mask.id)) {
    return "id must be 2-32 lowercase letters, digits or dashes, starting with a letter";
  }
  if (Object.hasOwn(BUILTIN_MASKS, mask.id)) return `${mask.id} is a built-in mask`;
  if (typeof mask.label !== "string" || !mask.label.trim() || mask.label.length > 120) {
    return "label is required, up to 120 characters";
  }
  const parts = maskableParts();
  const lists = [
    ["fields", mask.fields, parts.fields],
    ["routes", mask.routes, parts.routes],
    ["filters", mask.filters, parts.filters],
  ] as const;
  for (const [name, value, known] of lists) {
    if (!Array.isArray(value)) return `${name} must be a list`;
    const unknown = value.filter((item) => !known.includes(item));
    if (unknown.length) return `unknown ${name}: ${unknown.join(", ")}`;
  }
  const total = lists.reduce((sum, [, value]) => sum + (value as unknown[]).length, 0);
  return total === 0 ? "a mask must hide at least one field, route or filter" : null;
}

/** Create or replace a custom mask. Call checkCustomMask first. */
export function saveCustomMask(mask: Omit<Mask, "builtin">): void {
  db()
    .query(
      `INSERT INTO custom_masks (id, label, fields, routes, filters) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET label = excluded.label, fields = excluded.fields,
         routes = excluded.routes, filters = excluded.filters`,
    )
    .run(
      mask.id,
      mask.label.trim(),
      JSON.stringify([...new Set(mask.fields)]),
      JSON.stringify([...new Set(mask.routes)]),
      JSON.stringify([...new Set(mask.filters)]),
    );
}

/** Roles still carrying the mask; deleting it would quietly unhide what it covers. */
export function rolesUsing(id: string): string[] {
  return db()
    .query<{ role: string }, [string]>("SELECT role FROM role_masks WHERE mask = ? ORDER BY role")
    .all(id)
    .map((row) => row.role);
}

export function deleteCustomMask(id: string): boolean {
  return db().query("DELETE FROM custom_masks WHERE id = ?").run(id).changes > 0;
}

/** Applied the first time the engine opens a database, then left to the admin. */
const DEFAULTS: Partial<Record<Role, (keyof typeof BUILTIN_MASKS)[]>> = {
  limited: ["contact", "housing", "hometown", "photo", "schedule", "majors", "facts", "history"],
};

const SEEDED = { role: "*", mask: "seeded" };

function seedDefaults(): void {
  const database = db();
  database.transaction(() => {
    const inserted = database
      .query("INSERT OR IGNORE INTO role_masks (role, mask) VALUES (?, ?)")
      .run(SEEDED.role, SEEDED.mask);
    if (inserted.changes === 0) return;
    const insert = database.query("INSERT OR IGNORE INTO role_masks (role, mask) VALUES (?, ?)");
    for (const [role, masks] of Object.entries(DEFAULTS)) {
      for (const mask of masks) insert.run(role, mask);
    }
  })();
}

export function masksFor(role: Role): string[] {
  if (role === "admin") return [];
  seedDefaults();
  const known = new Set(allMasks().map((mask) => mask.id));
  return db()
    .query<{ mask: string }, [string]>("SELECT mask FROM role_masks WHERE role = ? ORDER BY mask")
    .all(role)
    .map((row) => row.mask)
    .filter((mask) => known.has(mask));
}

export function setMasks(role: Role, masks: string[]): void {
  seedDefaults();
  const database = db();
  database.transaction(() => {
    database.query("DELETE FROM role_masks WHERE role = ?").run(role);
    const insert = database.query("INSERT INTO role_masks (role, mask) VALUES (?, ?)");
    for (const mask of new Set(masks)) insert.run(role, mask);
  })();
}

/** Whether `a` may do no more and see no more than `b`: fewer capabilities, at least b's masks. */
export function roleWithin(a: Role, b: Role): boolean {
  const caps = new Set<string>(ROLES[b]);
  if (!ROLES[a].every((capability) => caps.has(capability))) return false;
  const hidden = new Set(masksFor(a));
  return masksFor(b).every((mask) => hidden.has(mask));
}

export interface MaskPolicy {
  fields: Set<string>;
  routes: Set<string>;
  filters: string[];
}

export function policyFor(role: Role): MaskPolicy {
  const chosen = new Set(masksFor(role));
  const groups = allMasks().filter((mask) => chosen.has(mask.id));
  return {
    fields: new Set(groups.flatMap((g) => g.fields)),
    routes: new Set(groups.flatMap((g) => g.routes)),
    filters: groups.flatMap((g) => g.filters),
  };
}

/** The first query parameter the policy forbids, so filtering cannot recover a hidden value. */
export function forbiddenFilter(policy: MaskPolicy, url: URL): string | null {
  for (const name of url.searchParams.keys()) {
    const hit = policy.filters.some((filter) =>
      filter.endsWith(".*") ? name.startsWith(filter.slice(0, -1)) : name === filter,
    );
    if (hit) return name;
  }
  return null;
}

/**
 * Every person the store returns comes from one SELECT, so these keys mark a
 * person wherever it sits in a response. Courses, exams and majors also have
 * a `title` or `department`; this is what keeps a mask off them.
 */
const isPerson = (value: object): boolean =>
  "firstSeen" in value && "lastSeen" in value && "lastName" in value;

/** History rows name the column (`dorm_room`); masks name the API field (`dormRoom`). */
const camel = (column: string) => column.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

/** A change to one of a person's fields, from /history: kind, field, was and now. */
const isFieldChange = (value: object): value is { field: string | null } =>
  "field" in value && "was" in value && "now" in value && "kind" in value;

/** The roommates answer carries the person's own room and suite beside the people. */
const isRoommates = (value: object): boolean => "roommates" in value && "suitemates" in value;

const DROP = Symbol("drop");

function redact(value: unknown, fields: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, fields)).filter((item) => item !== DROP);
  }
  if (!value || typeof value !== "object") return value;
  // The old and new value of a hidden field are that field, so the whole change goes.
  if (isFieldChange(value) && value.field && fields.has(camel(value.field))) return DROP;

  const person = isPerson(value);
  const hideRoom = isRoommates(value) && fields.has("dormRoom");
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !(person && fields.has(key)))
      .map(([key, inner]) => {
        if (hideRoom && (key === "room" || key === "suite")) return [key, null];
        return [key, redact(inner, fields)];
      }),
  );
}

/** A copy of a JSON value with the hidden fields removed wherever they would show. */
export function stripFields(value: unknown, fields: Set<string>): unknown {
  const result = redact(value, fields);
  return result === DROP ? null : result;
}
