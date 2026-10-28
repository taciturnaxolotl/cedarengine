import { beforeEach, describe, expect, test } from "bun:test";
import { useDatabase } from "../src/db";
import { searchPeople, upsertPeople } from "../src/store/people";

const person = (id: string, first: string, last: string) => ({
  Id: id,
  FirstName: first,
  LastName: last,
  StudentType: "UG",
  StudentClass: "FR",
});

const found = (q: string) => searchPeople({ q }).map((p) => p.id);

beforeEach(() => {
  useDatabase(":memory:");
  upsertPeople(
    [
      person("1", "Peter", "Van Etten"),
      person("2", "Kieran", "Klukas"),
      person("3", "Mary", "Smith-Jones"),
      person("4", "Peter", "Ettenger"),
    ],
    "2026-01-01T00:00:00.000Z",
  );
});

describe("searching people by name", () => {
  test("a last name with a space is found by any of its words", () => {
    expect(found("peter etten")).toEqual(["4", "1"]);
    expect(found("peter van etten")).toEqual(["1"]);
    expect(found("peter van")).toEqual(["1"]);
    expect(found("etten")).toEqual(["4", "1"]);
  });

  test("the whole query may be a last name", () => {
    expect(found("van etten")).toEqual(["1"]);
  });

  test("hyphenated names split too", () => {
    expect(found("mary jones")).toEqual(["3"]);
  });

  test("a hyphen typed in the query is honoured", () => {
    expect(found("mary smith-jones")).toEqual(["3"]);
    expect(found("smith-jones")).toEqual(["3"]);
    expect(found("smith-jo")).toEqual(["3"]);
  });

  test("first then last still means first then last", () => {
    expect(found("kieran klukas")).toEqual(["2"]);
    expect(found("klukas kieran")).toEqual([]);
  });

  test("one word still reaches nicknames and usernames", () => {
    upsertPeople(
      [{ ...person("5", "Robert", "Tables"), Nickname: "Bobby", Username: "rtables" }],
      "2026-01-01T00:00:00.000Z",
    );
    expect(found("bobby")).toEqual(["5"]);
    expect(found("rtab")).toEqual(["5"]);
    expect(found("bobby tables")).toEqual(["5"]);
  });
});
