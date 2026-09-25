/**
 * One database, four sources.
 *
 * The directory, the course catalog, the printed book and the harvested
 * booklists arrive from four different places on four different schedules, and
 * every interesting question crosses at least two of them: who is in this
 * dorm, what is that person most likely studying, which sections of the course
 * their program requires still have seats. Kept in four files they can only be
 * joined in application code; kept here they are one query.
 *
 * Payload columns hold the upstream record verbatim. The named columns beside
 * them are the fields worth indexing, extracted on write so a search is an
 * index scan rather than ten thousand JSON parses.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id            TEXT PRIMARY KEY,
  username      TEXT,
  first_name    TEXT,
  last_name     TEXT,
  middle_name   TEXT,
  nickname      TEXT,
  city          TEXT,
  state         TEXT,
  country       TEXT,
  department    TEXT,
  title         TEXT,
  office_code   TEXT,
  office_name   TEXT,
  office_room   TEXT,
  office_phone  TEXT,
  dorm_code     TEXT,
  dorm_name     TEXT,
  dorm_room     TEXT,
  student_type  TEXT,
  student_class TEXT,
  student_worker TEXT,
  emp_inactive  TEXT,
  photo_url     TEXT,
  payload       TEXT NOT NULL,
  -- Whether the last complete sweep still found them. Graduating, transferring
  -- and being hired all look the same from here: a row that stops coming back.
  present       INTEGER NOT NULL DEFAULT 1,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS people_last ON people (last_name);
CREATE INDEX IF NOT EXISTS people_first ON people (first_name);
CREATE INDEX IF NOT EXISTS people_dorm ON people (dorm_name);
CREATE INDEX IF NOT EXISTS people_type ON people (student_type, student_class);

CREATE INDEX IF NOT EXISTS people_present ON people (present);

-- Who arrived, who left, and what changed about the ones who stayed.
--
-- The directory is a snapshot API: ask it today and it tells you today. Every
-- interesting question about it is longitudinal — when someone moved dorms,
-- which class actually graduated, whether a booklist shifted mid-semester —
-- and none of that survives an upsert. So every change is written down as it
-- happens, and the current row is just the latest frame.
CREATE TABLE IF NOT EXISTS person_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,  -- appeared | changed | vanished | returned
  field      TEXT,
  was        TEXT,
  now        TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS person_events_student ON person_events (student_id, seq);
CREATE INDEX IF NOT EXISTS person_events_at ON person_events (at);
CREATE INDEX IF NOT EXISTS person_events_kind ON person_events (kind, at);

-- One row per collection run, whoever ran it: the CLI sweep, the browser
-- extension, a manual ingest. "Vanished" is only meaningful against a run that
-- claimed to see everybody, which is what "complete" records.
CREATE TABLE IF NOT EXISTS sweeps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,  -- directory | booklists | catalog | book
  source      TEXT NOT NULL,  -- cli | extension | import
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  complete    INTEGER NOT NULL DEFAULT 0,
  seen        INTEGER NOT NULL DEFAULT 0,
  added       INTEGER NOT NULL DEFAULT 0,
  changed     INTEGER NOT NULL DEFAULT 0,
  vanished    INTEGER NOT NULL DEFAULT 0,
  note        TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS sweeps_kind ON sweeps (kind, started_at);

-- Sweep bookkeeping: which (last, first) prefix pairs have been asked, and how
-- many rows came back. A run that dies mid-sweep resumes from these.
CREATE TABLE IF NOT EXISTS sweep_queries (
  last  TEXT NOT NULL,
  first TEXT NOT NULL,
  count INTEGER NOT NULL,
  at    TEXT NOT NULL,
  PRIMARY KEY (last, first)
) STRICT;

CREATE TABLE IF NOT EXISTS sections (
  term       TEXT NOT NULL,
  section_id TEXT NOT NULL,
  course_id  TEXT NOT NULL,
  code       TEXT,
  name       TEXT,
  title      TEXT,
  faculty    TEXT,
  meetings   TEXT,
  available  INTEGER,
  capacity   INTEGER,
  payload    TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (term, section_id)
) STRICT;

CREATE INDEX IF NOT EXISTS sections_course ON sections (term, course_id);
CREATE INDEX IF NOT EXISTS sections_code ON sections (code);

CREATE TABLE IF NOT EXISTS courses (
  term       TEXT NOT NULL,
  course_id  TEXT NOT NULL,
  code       TEXT,
  subject    TEXT,
  number     TEXT,
  title      TEXT,
  credits    REAL,
  payload    TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (term, course_id)
) STRICT;

CREATE INDEX IF NOT EXISTS courses_code ON courses (code);
CREATE INDEX IF NOT EXISTS courses_subject ON courses (subject);

-- Requirement groups Colleague will not enumerate in an evaluation, resolved
-- once via the course search. The same rule resolves the same way for
-- everyone, so these are keyed by catalog coordinates, never by student.
CREATE TABLE IF NOT EXISTS rule_groups (
  requirement    TEXT NOT NULL,
  subrequirement TEXT NOT NULL,
  grp            TEXT NOT NULL,
  courses        TEXT NOT NULL,
  fetched_at     TEXT NOT NULL,
  PRIMARY KEY (requirement, subrequirement, grp)
) STRICT;

CREATE TABLE IF NOT EXISTS programs (
  year          TEXT NOT NULL,
  page          INTEGER NOT NULL,
  title         TEXT NOT NULL,
  total_credits REAL,
  courses       TEXT NOT NULL,
  payload       TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  PRIMARY KEY (year, page)
) STRICT;

CREATE INDEX IF NOT EXISTS programs_title ON programs (title);

-- One student's booklist for one term, plus the course codes it leaks. More
-- terms per student is a richer fingerprint, which is the whole premise of the
-- major model.
CREATE TABLE IF NOT EXISTS booklists (
  term       TEXT NOT NULL,
  student_id TEXT NOT NULL,
  books      TEXT NOT NULL,
  codes      TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (term, student_id)
) STRICT;

CREATE INDEX IF NOT EXISTS booklists_student ON booklists (student_id);

-- A booklist that changes mid-term is a schedule change: a course added, one
-- dropped. That is signal the merged fingerprint throws away, so the delta is
-- kept even though the current list is what gets scored.
CREATE TABLE IF NOT EXISTS booklist_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  term       TEXT NOT NULL,
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,  -- first | changed
  added      TEXT NOT NULL,
  removed    TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS booklist_events_student ON booklist_events (student_id, seq);
CREATE INDEX IF NOT EXISTS booklist_events_term ON booklist_events (term, at);

-- The registrar's own taxonomy: every program, the department that teaches it,
-- and the school it belongs to.
--
-- Worth having for its own sake, and worth more than that to the model: eleven
-- schools is a better bucket than eight regexes I wrote by hand, and it is the
-- university's own answer to "how close was that guess" rather than mine.
CREATE TABLE IF NOT EXISTS majors (
  program    TEXT NOT NULL,
  level      TEXT NOT NULL,   -- major | minor | concentration | ...
  department TEXT,
  school     TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (program, level)
) STRICT;

CREATE INDEX IF NOT EXISTS majors_school ON majors (school);

-- Known majors, for scoring the model against reality.
CREATE TABLE IF NOT EXISTS labels (
  student_id TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  major      TEXT NOT NULL,
  major2     TEXT,
  at         TEXT NOT NULL
) STRICT;

-- Anything anybody has asserted about a person that the directory does not
-- carry: a GroupMe id, a 16personalities type, a photograph somebody took.
--
-- The directory sweep rewrites "people" on every run, so none of this can live
-- there. It is keyed by student id and survives both a sweep and the person
-- vanishing from it, which is the point: a graduate still had a GroupMe id.
--
-- Append-only, for the same reason person_events is. Every source here is a
-- snapshot too — a personality test gets retaken, a photograph gets replaced,
-- a hand-made identification turns out to have been the other Grace Anderson.
-- The newest row for a (student_id, key, source, slot) is the truth and the
-- rows behind it are how we got there. Nothing is deleted; "retracted" marks a
-- tombstone, which also means a bad write is recoverable rather than fatal.
--
-- "value" is the scalar as plain text wherever it can be, and JSON only when
-- the fact really is structured. That is what makes key = 'groupme.id' AND
-- value = '12345' an index hit rather than a quoting puzzle, and it follows
-- the rule the rest of this schema keeps: what is worth searching gets a
-- column, not a json_extract at query time.
CREATE TABLE IF NOT EXISTS person_facts (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  -- '' for a fact a person has one of. For a fact they have several of — a
  -- photograph — whatever names this one, so a sixth photo is an append
  -- rather than a read, a rewrite of the list, and a race with whoever else
  -- was adding one.
  slot       TEXT    NOT NULL DEFAULT '',
  value      TEXT    NOT NULL,
  json       INTEGER NOT NULL DEFAULT 0,
  source     TEXT    NOT NULL,
  at         TEXT    NOT NULL,
  retracted  INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS person_facts_person ON person_facts (student_id, key, seq);
-- The reverse question, which is the one an outside system actually asks:
-- given a GroupMe id, who is that?
CREATE INDEX IF NOT EXISTS person_facts_lookup ON person_facts (key, value);

-- The latest assertion of every fact, which is what nearly every read wants.
-- Kept as a view so no caller has to remember that the table is a log.
CREATE VIEW IF NOT EXISTS current_facts AS
SELECT seq, student_id, key, slot, value, json, source, at
FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY student_id, key, source, slot ORDER BY seq DESC
  ) AS rn
  FROM person_facts
)
WHERE rn = 1 AND retracted = 0;

CREATE TABLE IF NOT EXISTS metrics (
  at       TEXT NOT NULL,
  source   TEXT NOT NULL,
  terms    TEXT NOT NULL,
  scored   INTEGER NOT NULL,
  exact    REAL NOT NULL,
  top3     REAL NOT NULL,
  cluster  REAL NOT NULL,
  PRIMARY KEY (at, source)
) STRICT;

-- The campus itself: outlines to draw, and a walking graph to route on.
--
-- Merged in from the assassins project, where the map was built to chase
-- people around. The same graph answers quieter questions here: how far a
-- freshman walks in a day, which dorms feed which building, where a class of
-- people actually is at ten in the morning. Every person already carries a
-- dorm or an office name, so the join needs nothing new from anybody.
CREATE TABLE IF NOT EXISTS campus (
  key        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fetched_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS buildings (
  label      TEXT PRIMARY KEY,   -- as the directory and catalog write it
  osm_name   TEXT,
  kind       TEXT,               -- dorm | office | both | unknown
  lat        REAL,
  lon        REAL,
  x          REAL,               -- metres east of the map origin
  y          REAL,               -- metres south of it
  node       INTEGER,            -- nearest walking-graph node, i.e. the door
  gender     TEXT,               -- male | female | mixed, for the halls
  ring       TEXT,               -- outline, in map metres
  source     TEXT NOT NULL,      -- osm | tour
  fetched_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS requests (
  at       TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status   INTEGER NOT NULL,
  ms       REAL NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS requests_at ON requests (at);
`;

let handle: Database | undefined;

/** The one database. Opened on first use so the CLI and server share it. */
export function db(path = config.databasePath): Database {
  if (handle) return handle;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  handle = new Database(path, { create: true });
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA synchronous = NORMAL");
  handle.exec("PRAGMA foreign_keys = ON");
  handle.exec(SCHEMA);
  return handle;
}

/** Point the process at a different file. Tests use ":memory:". */
export function useDatabase(path: string): Database {
  handle?.close();
  handle = undefined;
  return db(path);
}

export function closeDatabase(): void {
  handle?.close();
  handle = undefined;
}
