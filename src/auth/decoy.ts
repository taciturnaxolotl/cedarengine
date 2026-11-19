/**
 * What a canary token sees.
 *
 * A canary is a token planted to be stolen. Whoever uses one should believe it
 * works, so catalog and campus routes answer for real (that data is public
 * anyway), while anything about a person answers with invented people. The
 * same query always gets the same invention, so a scraper comparing runs
 * finds nothing odd. Every hit lands in the audit log flagged as a canary.
 */

import { json, notFound } from "../lib/http";
import { stream } from "../lib/seeded";
import type { Person } from "../store/people";

const FIRST = [
  "Abigail",
  "Caleb",
  "Hannah",
  "Isaac",
  "Lydia",
  "Micah",
  "Naomi",
  "Silas",
  "Tabitha",
  "Josiah",
  "Eliza",
  "Gideon",
  "Priscilla",
  "Asher",
  "Ruth",
  "Ezra",
];
const LAST = [
  "Whitfield",
  "Ashby",
  "Kettering",
  "Lindqvist",
  "Marchetti",
  "Okafor",
  "Pemberton",
  "Rasmussen",
  "Sorensen",
  "Thackeray",
  "Vandermeer",
  "Yoder",
  "Brannigan",
  "Castellano",
];
const DORMS = [
  "Brock Hall",
  "Lawlor Hall",
  "Printy Hall",
  "Willetts Hall",
  "Hartman Hall",
  "McKinney Hall",
];
const DEPARTMENTS = [
  "Engineering",
  "Nursing",
  "Business",
  "Biblical Studies",
  "Music",
  "Computer Science",
];
const CLASSES = ["FR", "SO", "JR", "SR"];

const pick = <T>(next: () => number, from: readonly T[]): T => from[next() % from.length]!;

export function decoyPerson(id: string, lastName?: string): Person {
  const next = stream(`person:${id}`);
  const first = pick(next, FIRST);
  const last = lastName ?? pick(next, LAST);
  const dorm = pick(next, DORMS);
  const username = `${first[0]}${last}`.toLowerCase().replace(/[^a-z]/g, "");
  return {
    id,
    username,
    firstName: first,
    lastName: last,
    middleName: null,
    nickname: null,
    city: null,
    state: "OH",
    country: "USA",
    department: pick(next, DEPARTMENTS),
    title: null,
    officeCode: null,
    officeName: null,
    officeRoom: null,
    officePhone: null,
    dormCode: dorm.slice(0, 2).toUpperCase(),
    dormName: dorm,
    dormRoom: `${dorm[0]}${100 + (next() % 300)}`,
    studentType: "UG",
    studentClass: pick(next, CLASSES),
    studentWorker: null,
    empInactive: null,
    photoUrl: null,
    email: `${username}@cedarville.edu`,
    reunionClass: String(2027 + (next() % 4)),
    poBox: String(1000 + (next() % 4000)),
    present: 1,
    firstSeen: "2025-08-20T12:00:00.000Z",
    lastSeen: new Date().toISOString().slice(0, 10).concat("T06:00:00.000Z"),
  };
}

const decoyId = (next: () => number) => String(3_000_000 + (next() % 900_000));

const titleCase = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/** A decoy response for a person route, or null to let the real handler answer. */
export function decoyResponse(
  route: string,
  url: URL,
  params: Record<string, string>,
): Response | null {
  if (route === "/v1/people") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    const next = stream(`search:${url.searchParams.toString()}`);
    const lastName = q ? titleCase(q.split(/\s+/).at(-1)!) : undefined;
    const limit = Math.min(Number(url.searchParams.get("limit")) || 25, 25);
    const count = q ? 1 + (next() % 4) : limit;
    return json({
      people: Array.from({ length: count }, () => decoyPerson(decoyId(next), lastName)),
    });
  }
  if (route === "/v1/people/:id") return json(decoyPerson(params.id ?? "0"));
  throw notFound("no such person");
}
