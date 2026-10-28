/**
 * The directory, as the engine keeps it.
 *
 * Upstream hands back PascalCase columns and empty strings where a field does
 * not apply. Both get normalised on the way in: snake_case names because this
 * schema is ours now, and NULL for "no value" because `COALESCE(x,'') <> ''`
 * in every query is a tax paid forever for a decision made once.
 */

import { db } from "../db";

export interface DirectoryRow {
  [key: string]: unknown;
  Id?: string | number;
}

export interface Person {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  nickname: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  department: string | null;
  title: string | null;
  officeCode: string | null;
  officeName: string | null;
  officeRoom: string | null;
  officePhone: string | null;
  dormCode: string | null;
  dormName: string | null;
  dormRoom: string | null;
  studentType: string | null;
  studentClass: string | null;
  studentWorker: string | null;
  empInactive: string | null;
  photoUrl: string | null;
  /** 1 while the last complete sweep still found them. */
  present: number;
  firstSeen: string;
  lastSeen: string;
}

/** Upstream field → our column. The order here is the order of the INSERT. */
const FIELDS: [column: string, upstream: string][] = [
  ["id", "Id"],
  ["username", "Username"],
  ["first_name", "FirstName"],
  ["last_name", "LastName"],
  ["middle_name", "MiddleName"],
  ["nickname", "Nickname"],
  ["city", "AddressCity"],
  ["state", "AddressState"],
  ["country", "AddressCountry"],
  ["department", "DepartmentDescription"],
  ["title", "Title"],
  ["office_code", "OfficeBuildingCode"],
  ["office_name", "OfficeBuildingName"],
  ["office_room", "OfficeRoom"],
  ["office_phone", "OfficePhone"],
  ["dorm_code", "DormCode"],
  ["dorm_name", "DormName"],
  ["dorm_room", "DormRoom"],
  ["student_type", "StudentType"],
  ["student_class", "StudentClass"],
  ["student_worker", "studentWorker"],
  ["emp_inactive", "empInactive"],
  ["photo_url", "PhotoUrl"],
];

const COLUMNS = FIELDS.map(([c]) => c);

const value = (row: DirectoryRow, key: string): string | null => {
  const raw = row[key];
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  return text === "" ? null : text;
};

const SELECT = `SELECT
  id, username, first_name AS firstName, last_name AS lastName, middle_name AS middleName,
  nickname, city, state, country, department, title,
  office_code AS officeCode, office_name AS officeName, office_room AS officeRoom,
  office_phone AS officePhone, dorm_code AS dormCode, dorm_name AS dormName,
  dorm_room AS dormRoom, student_type AS studentType, student_class AS studentClass,
  student_worker AS studentWorker, emp_inactive AS empInactive, photo_url AS photoUrl,
  first_seen AS firstSeen, last_seen AS lastSeen
FROM people`;

export interface UpsertTally {
  seen: number;
  added: number;
  changed: number;
}

/**
 * Fields worth a history entry.
 *
 * A dorm move, a class year rolling over, a title appearing: each is a fact
 * about a person changing, and each is invisible the moment it is overwritten.
 * Photo urls and usernames churn for reasons nobody cares about, so they are
 * updated silently.
 */
const TRACKED = [
  "first_name",
  "last_name",
  "nickname",
  "department",
  "title",
  "office_name",
  "office_room",
  "office_phone",
  "dorm_name",
  "dorm_room",
  "student_type",
  "student_class",
] as const;

/**
 * Insert or refresh a batch, writing down what changed.
 *
 * The diff happens before the write, because after it the previous value is
 * gone. That is the whole reason this function is not three lines.
 */
export function upsertPeople(rows: DirectoryRow[], at = new Date().toISOString()): UpsertTally {
  const database = db();
  const insert = database.query(
    `INSERT INTO people (${COLUMNS.join(", ")}, payload, present, first_seen, last_seen)
     VALUES (${COLUMNS.map(() => "?").join(", ")}, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       ${COLUMNS.slice(1)
         .map((c) => `${c} = excluded.${c}`)
         .join(",\n       ")},
       payload = excluded.payload,
       present = 1,
       last_seen = excluded.last_seen`,
  );
  const before = database.query<Record<string, string | null>, [string]>(
    `SELECT ${TRACKED.join(", ")}, present FROM people WHERE id = ?`,
  );
  const event = database.query(
    "INSERT INTO person_events (student_id, at, kind, field, was, now) VALUES (?, ?, ?, ?, ?, ?)",
  );

  const tally: UpsertTally = { seen: 0, added: 0, changed: 0 };
  const run = database.transaction(() => {
    for (const row of rows) {
      const id = value(row, "Id");
      if (!id) continue;
      tally.seen++;

      const previous = before.get(id);
      const values = FIELDS.map(([, key]) => value(row, key));
      insert.run(...values, JSON.stringify(row), at, at);

      if (!previous) {
        tally.added++;
        event.run(id, at, "appeared", null, null, null);
        continue;
      }
      if (Number(previous.present) === 0) event.run(id, at, "returned", null, null, null);

      let changed = false;
      for (const field of TRACKED) {
        const was = previous[field] ?? null;
        const now = values[COLUMNS.indexOf(field)] ?? null;
        if (was === now) continue;
        changed = true;
        event.run(id, at, "changed", field, was, now);
      }
      if (changed) tally.changed++;
    }
  });
  run();
  return tally;
}

/**
 * Retire everyone a complete sweep did not see.
 *
 * Only ever called with the timestamp a full sweep started: a row older than
 * that was not refreshed, and a sweep that saw everybody not refreshing you
 * means you are no longer in the directory. Partial sweeps must never call
 * this, or every person outside the slice would "graduate" at once.
 */
export function retireUnseen(since: string): number {
  const database = db();
  const gone = database
    .query<{ id: string }, [string]>("SELECT id FROM people WHERE present = 1 AND last_seen < ?")
    .all(since);

  const event = database.query(
    "INSERT INTO person_events (student_id, at, kind, field, was, now) VALUES (?, ?, 'vanished', NULL, NULL, NULL)",
  );
  const retire = database.query("UPDATE people SET present = 0 WHERE id = ?");
  const at = new Date().toISOString();

  const run = database.transaction(() => {
    for (const person of gone) {
      retire.run(person.id);
      event.run(person.id, at);
    }
  });
  run();
  return gone.length;
}

export interface PeopleQuery {
  q?: string;
  first?: string;
  last?: string;
  dorm?: string;
  department?: string;
  type?: string;
  class?: string;
  /** Facts that must be true of them: key to value. */
  facts?: Record<string, string>;
  /** Facts they must carry, whatever the value says. */
  has?: string[];
  /** Include people the directory has stopped listing. Off by default. */
  includeGone?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Name search over the whole population.
 *
 * `q` is matched as a prefix against first, last, nickname and username, and
 * a two-word `q` is read as "first last" — which is how people actually type a
 * name, and the only reason searching "kieran klukas" beats searching "kieran".
 * Words match inside names too, so "peter etten" finds Peter Van Etten.
 */
export function searchPeople(query: PeopleQuery): Person[] {
  const where: string[] = [];
  if (!query.includeGone) where.push("present = 1");
  const args: (string | number)[] = [];

  const typed = (query.q ?? "").trim().replace(/\s+/g, " ");
  const words = typed.split(/[\s-]+/).filter(Boolean);
  if (words.length) {
    const each = words.map((_, i) => `${nameWords(namesFor(i, words.length))} LIKE ?`);
    where.push(`((${each.join(" AND ")}) OR last_name LIKE ?)`);
    args.push(...words.map((word) => `% ${word}%`), `${typed}%`);
  }

  const exact: [string, string | undefined][] = [
    ["first_name", query.first],
    ["last_name", query.last],
    ["dorm_name", query.dorm],
    ["department", query.department],
    ["student_type", query.type],
    ["student_class", query.class],
  ];
  for (const [column, given] of exact) {
    if (!given) continue;
    where.push(`${column} LIKE ?`);
    args.push(given);
  }

  // Facts live in their own table, so this could be a join. EXISTS instead,
  // for two reasons: the shared SELECT above names its columns unqualified, so
  // a join risks an ambiguous `source` or `at` the moment either side grows a
  // column; and a person with six photographs would arrive six times, which
  // makes LIMIT mean something other than "people".
  for (const [key, value] of Object.entries(query.facts ?? {})) {
    where.push(
      `EXISTS (SELECT 1 FROM current_facts f
               WHERE f.student_id = people.id AND f.key = ? AND f.value = ?)`,
    );
    args.push(key, value);
  }
  for (const key of query.has ?? []) {
    where.push(
      `EXISTS (SELECT 1 FROM current_facts f WHERE f.student_id = people.id AND f.key = ?)`,
    );
    args.push(key);
  }

  const limit = Math.min(Math.max(query.limit ?? 25, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  const sql = `${SELECT}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY last_name, first_name
    LIMIT ? OFFSET ?`;

  return db()
    .query<Person, any[]>(sql)
    .all(...args, limit, offset);
}

const GIVEN = ["first_name", "nickname"];
const FAMILY = ["last_name"];

/** Which names the i-th of n query words may start: first given, last family, between either. */
function namesFor(i: number, n: number): string[] {
  if (n === 1) return [...GIVEN, ...FAMILY, "username"];
  if (i === 0) return GIVEN;
  if (i === n - 1) return FAMILY;
  return [...GIVEN, ...FAMILY];
}

/** The columns as space-led words, so `LIKE '% w%'` means "a word starts with w". */
const nameWords = (columns: string[]) =>
  `(' ' || replace(${columns.map((c) => `coalesce(${c}, '')`).join(" || ' ' || ")}, '-', ' '))`;

export const personById = (id: string): Person | null =>
  db().query<Person, [string]>(`${SELECT} WHERE id = ?`).get(id);

/**
 * A suite from a room, where the hall has suites.
 *
 * The suite halls number a bedroom as the suite plus a letter — Lawlor's `02A`
 * through `02D` are four bedrooms off suite `02` — and the College View
 * apartments write it as `101-1`. A traditional hall's room ends in a digit and
 * has no suite above it, so it is returned unchanged and is its own suite.
 */
export function suiteOf(room: string): string {
  const apartment = room.match(/^(.+)-\d+$/);
  if (apartment) return apartment[1] as string;
  const bedroom = room.match(/^(.+)[A-Za-z]$/);
  if (bedroom) return bedroom[1] as string;
  return room;
}

export interface Roommates {
  /** The person's own room and suite. `suite` is null when the hall has none. */
  room: string | null;
  suite: string | null;
  /** Others in the exact same room. */
  roommates: Person[];
  /** Others in the same suite but a different room. Empty without suites. */
  suitemates: Person[];
}

/**
 * Who the directory lists living with somebody: the people in their room, and
 * in a suite hall the rest of their suite.
 *
 * Empty for anyone without a room — staff, commuters, and the handful of
 * students the directory gives a hall but no room number. A room number is only
 * a room within one hall, so the hall has to match before anyone counts.
 */
export function roommates(id: string): Roommates {
  const database = db();
  const self = database
    .query<{ dormName: string | null; dormRoom: string | null }, [string]>(
      "SELECT dorm_name AS dormName, dorm_room AS dormRoom FROM people WHERE id = ?",
    )
    .get(id);

  const none: Roommates = { room: null, suite: null, roommates: [], suitemates: [] };
  if (!self?.dormName || !self?.dormRoom) return none;

  const hall = database
    .query<Person, [string, string]>(
      `${SELECT} WHERE present = 1 AND dorm_name = ? AND dorm_room IS NOT NULL AND id <> ?
       ORDER BY last_name, first_name`,
    )
    .all(self.dormName, id);

  const suite = suiteOf(self.dormRoom);
  const roommates: Person[] = [];
  const suitemates: Person[] = [];
  for (const person of hall) {
    const room = person.dormRoom as string;
    if (room === self.dormRoom) roommates.push(person);
    else if (suiteOf(room) === suite) suitemates.push(person);
  }

  return {
    room: self.dormRoom,
    suite: suite === self.dormRoom ? null : suite,
    roommates,
    suitemates,
  };
}

/** Name → id, the join the major model needs. Nicknames count as first names. */
export function findByName(first: string, last: string): Person[] {
  return db()
    .query<Person, [string, string, string]>(
      `${SELECT} WHERE lower(last_name) = lower(?)
       AND (lower(first_name) = lower(?) OR lower(nickname) = lower(?))`,
    )
    .all(last, first, first);
}

export interface PeopleStats {
  people: number;
  gone: number;
  students: number;
  staff: number;
  withDorm: number;
  lastSweep: string | null;
  byClass: { key: string; n: number }[];
  byDorm: { key: string; n: number }[];
}

export function peopleStats(): PeopleStats {
  const database = db();
  const one = (sql: string) => database.query<{ n: number }, []>(sql).get()?.n ?? 0;
  return {
    people: one("SELECT COUNT(*) AS n FROM people WHERE present = 1"),
    gone: one("SELECT COUNT(*) AS n FROM people WHERE present = 0"),
    students: one(
      "SELECT COUNT(*) AS n FROM people WHERE present = 1 AND student_type IS NOT NULL",
    ),
    staff: one("SELECT COUNT(*) AS n FROM people WHERE present = 1 AND title IS NOT NULL"),
    withDorm: one("SELECT COUNT(*) AS n FROM people WHERE present = 1 AND dorm_name IS NOT NULL"),
    lastSweep:
      database.query<{ at: string | null }, []>("SELECT MAX(last_seen) AS at FROM people").get()
        ?.at ?? null,
    byClass: database
      .query<{ key: string; n: number }, []>(
        `SELECT student_class AS key, COUNT(*) AS n FROM people
         WHERE present = 1 AND student_class IS NOT NULL GROUP BY key ORDER BY n DESC`,
      )
      .all(),
    byDorm: database
      .query<{ key: string; n: number }, []>(
        `SELECT dorm_name AS key, COUNT(*) AS n FROM people
         WHERE present = 1 AND dorm_name IS NOT NULL GROUP BY key ORDER BY n DESC`,
      )
      .all(),
  };
}

/** Ids to sweep for booklists, in the order the harvester should walk them. */
export function studentIds(types: string[], studentClass?: string): string[] {
  const args: string[] = [...types];
  let sql = `SELECT id FROM people
    WHERE present = 1 AND student_type IN (${types.map(() => "?").join(",")})`;
  if (studentClass) {
    sql += " AND student_class = ?";
    args.push(studentClass);
  }
  sql += " ORDER BY last_name, first_name";
  return db()
    .query<{ id: string }, string[]>(sql)
    .all(...args)
    .map((r) => r.id);
}
