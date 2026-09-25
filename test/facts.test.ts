import { beforeEach, describe, expect, test } from "bun:test";
import { useDatabase } from "../src/db";
import {
  assertFacts,
  factDistribution,
  factHistory,
  factKeys,
  factsFor,
  peopleWithFact,
  retractEvery,
  retractFact,
} from "../src/store/facts";
import { searchPeople, upsertPeople } from "../src/store/people";

const person = (id: string, over: Record<string, unknown> = {}) => ({
  Id: id,
  FirstName: "Ada",
  LastName: "Lovelace",
  DormName: "Printy Hall",
  DormRoom: "P101",
  StudentType: "UG",
  StudentClass: "FR",
  ...over,
});

beforeEach(() => {
  useDatabase(":memory:");
  upsertPeople(
    [person("1"), person("2", { FirstName: "Grace", LastName: "Hopper" })],
    "2026-01-01T00:00:00.000Z",
  );
});

describe("asserting facts", () => {
  test("the newest assertion from a source is the one that counts", () => {
    assertFacts(
      "1",
      [{ key: "16p.type", value: "INTJ", source: "survey" }],
      "2026-01-01T00:00:00Z",
    );
    assertFacts(
      "1",
      [{ key: "16p.type", value: "INFJ", source: "survey" }],
      "2026-06-01T00:00:00Z",
    );

    const facts = factsFor("1");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.value).toBe("INFJ");
  });

  test("the earlier answer is still on the record", () => {
    assertFacts(
      "1",
      [{ key: "16p.type", value: "INTJ", source: "survey" }],
      "2026-01-01T00:00:00Z",
    );
    assertFacts(
      "1",
      [{ key: "16p.type", value: "INFJ", source: "survey" }],
      "2026-06-01T00:00:00Z",
    );

    expect(factHistory("1").map((f) => f.value)).toEqual(["INFJ", "INTJ"]);
  });

  test("two sources may disagree, and neither wins", () => {
    assertFacts("1", [{ key: "groupme.id", value: "111", source: "scrape" }]);
    assertFacts("1", [{ key: "groupme.id", value: "222", source: "manual" }]);

    const ids = factsFor("1").filter((f) => f.key === "groupme.id");
    expect(ids).toHaveLength(2);
    expect(ids.map((f) => f.value).sort()).toEqual(["111", "222"]);
  });

  test("a slot is what lets somebody have more than one photograph", () => {
    assertFacts("1", [
      { key: "photo", slot: "a.jpg", value: { url: "a.jpg", rotate: 90 }, source: "assassins" },
      { key: "photo", slot: "b.jpg", value: { url: "b.jpg", rotate: 0 }, source: "assassins" },
    ]);

    const photos = factsFor("1").filter((f) => f.key === "photo");
    expect(photos).toHaveLength(2);
    // Structure survives the round trip; a scalar would have come back a string.
    expect(photos[0]?.value).toEqual({ url: "a.jpg", rotate: 90 });
  });

  test("replacing one photograph leaves the others alone", () => {
    assertFacts("1", [
      { key: "photo", slot: "a.jpg", value: { url: "a.jpg", rotate: 0 }, source: "assassins" },
      { key: "photo", slot: "b.jpg", value: { url: "b.jpg", rotate: 0 }, source: "assassins" },
    ]);
    assertFacts("1", [
      { key: "photo", slot: "a.jpg", value: { url: "a.jpg", rotate: 270 }, source: "assassins" },
    ]);

    const photos = factsFor("1").filter((f) => f.key === "photo");
    expect(photos).toHaveLength(2);
    expect(photos.find((p) => p.slot === "a.jpg")?.value).toEqual({ url: "a.jpg", rotate: 270 });
  });
});

describe("retracting", () => {
  test("a retracted fact stops being current but stays in the log", () => {
    assertFacts("1", [{ key: "groupme.id", value: "12345", source: "assassins" }]);
    expect(retractFact("1", "groupme.id", "assassins")).toBe(true);

    expect(factsFor("1")).toHaveLength(0);
    expect(factHistory("1")).toHaveLength(2);
    expect(factHistory("1")[0]?.retracted).toBe(true);
  });

  test("retracting one source does not touch the other", () => {
    assertFacts("1", [{ key: "groupme.id", value: "111", source: "scrape" }]);
    assertFacts("1", [{ key: "groupme.id", value: "222", source: "manual" }]);
    retractFact("1", "groupme.id", "scrape");

    const left = factsFor("1");
    expect(left).toHaveLength(1);
    expect(left[0]?.source).toBe("manual");
  });

  test("a fact can be asserted again after being withdrawn", () => {
    assertFacts(
      "1",
      [{ key: "groupme.id", value: "12345", source: "assassins" }],
      "2026-01-01T00:00:00Z",
    );
    retractFact("1", "groupme.id", "assassins", "", "2026-02-01T00:00:00Z");
    assertFacts(
      "1",
      [{ key: "groupme.id", value: "99999", source: "assassins" }],
      "2026-03-01T00:00:00Z",
    );

    expect(factsFor("1").map((f) => f.value)).toEqual(["99999"]);
  });

  test("withdrawing something nobody claimed says so rather than pretending", () => {
    expect(retractFact("1", "16p.type", "survey")).toBe(false);
  });
});

describe("asking the reverse question", () => {
  test("a GroupMe id finds its person", () => {
    assertFacts("1", [{ key: "groupme.id", value: "12345", source: "assassins" }]);
    assertFacts("2", [{ key: "groupme.id", value: "67890", source: "assassins" }]);

    const found = peopleWithFact("groupme.id", "12345");
    expect(found).toHaveLength(1);
    expect(found[0]?.studentId).toBe("1");
  });

  test("a number and its text are the same id, because a caller will send either", () => {
    assertFacts("1", [{ key: "groupme.id", value: "12345", source: "assassins" }]);
    expect(peopleWithFact("groupme.id", 12345)).toHaveLength(1);
  });

  test("a retracted mapping stops answering", () => {
    assertFacts("1", [{ key: "groupme.id", value: "12345", source: "assassins" }]);
    retractFact("1", "groupme.id", "assassins");
    expect(peopleWithFact("groupme.id", "12345")).toHaveLength(0);
  });

  test("a distribution counts people, not assertions", () => {
    assertFacts(
      "1",
      [{ key: "16p.type", value: "INTJ", source: "survey" }],
      "2026-01-01T00:00:00Z",
    );
    assertFacts(
      "1",
      [{ key: "16p.type", value: "INTJ", source: "survey" }],
      "2026-02-01T00:00:00Z",
    );
    assertFacts("2", [{ key: "16p.type", value: "ENFP", source: "survey" }]);

    expect(factDistribution("16p.type")).toEqual([
      { value: "ENFP", n: 1 },
      { value: "INTJ", n: 1 },
    ]);
  });

  test("the key list is how you find out what is in here", () => {
    assertFacts("1", [{ key: "16p.type", value: "INTJ", source: "survey" }]);
    assertFacts("2", [{ key: "16p.type", value: "ENFP", source: "manual" }]);

    const keys = factKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ key: "16p.type", people: 2 });
    expect(keys[0]?.sources).toEqual(["manual", "survey"]);
  });
});

describe("searching people by fact", () => {
  test("a fact narrows the population", () => {
    assertFacts("1", [{ key: "16p.type", value: "INTJ", source: "survey" }]);
    assertFacts("2", [{ key: "16p.type", value: "ENFP", source: "survey" }]);

    const found = searchPeople({ facts: { "16p.type": "INTJ" } });
    expect(found.map((p) => p.id)).toEqual(["1"]);
  });

  test("it composes with the filters that were already there", () => {
    assertFacts("1", [{ key: "16p.type", value: "INTJ", source: "survey" }]);
    assertFacts("2", [{ key: "16p.type", value: "INTJ", source: "survey" }]);

    expect(
      searchPeople({ facts: { "16p.type": "INTJ" }, last: "Hopper" }).map((p) => p.id),
    ).toEqual(["2"]);
  });

  test("`has` asks whether we know it at all, not what it says", () => {
    assertFacts("1", [{ key: "groupme.id", value: "12345", source: "assassins" }]);
    expect(searchPeople({ has: ["groupme.id"] }).map((p) => p.id)).toEqual(["1"]);
  });

  test("somebody with six photographs is still one person in the results", () => {
    assertFacts("1", [
      { key: "photo", slot: "a.jpg", value: { url: "a.jpg" }, source: "assassins" },
      { key: "photo", slot: "b.jpg", value: { url: "b.jpg" }, source: "assassins" },
      { key: "photo", slot: "c.jpg", value: { url: "c.jpg" }, source: "assassins" },
    ]);

    expect(searchPeople({ has: ["photo"] })).toHaveLength(1);
  });

  test("a sweep rewrites the person and leaves the facts standing", () => {
    assertFacts("1", [{ key: "groupme.id", value: "12345", source: "assassins" }]);
    upsertPeople([person("1", { DormName: "Lawlor Hall" })], "2026-08-01T00:00:00.000Z");

    expect(factsFor("1").map((f) => f.value)).toEqual(["12345"]);
  });
});

describe("facts somebody can have more than one of", () => {
  test("a slot lets one person hold two GroupMe accounts", () => {
    assertFacts("1", [
      { key: "groupme.id", slot: "111", value: "111", source: "assassins" },
      { key: "groupme.id", slot: "222", value: "222", source: "assassins" },
    ]);

    const ids = factsFor("1").filter((f) => f.key === "groupme.id");
    expect(ids.map((f) => f.value).sort()).toEqual(["111", "222"]);
  });

  test("either account finds the person", () => {
    assertFacts("1", [
      { key: "groupme.id", slot: "111", value: "111", source: "assassins" },
      { key: "groupme.id", slot: "222", value: "222", source: "assassins" },
    ]);

    expect(peopleWithFact("groupme.id", "111")[0]?.studentId).toBe("1");
    expect(peopleWithFact("groupme.id", "222")[0]?.studentId).toBe("1");
  });

  test("re-asserting the same account changes nothing about the others", () => {
    assertFacts("1", [
      { key: "groupme.id", slot: "111", value: "111", source: "assassins" },
      { key: "groupme.id", slot: "222", value: "222", source: "assassins" },
    ]);
    assertFacts("1", [{ key: "groupme.id", slot: "111", value: "111", source: "assassins" }]);

    expect(factsFor("1").filter((f) => f.key === "groupme.id")).toHaveLength(2);
  });

  test("one account can be withdrawn without touching the other", () => {
    assertFacts("1", [
      { key: "groupme.id", slot: "111", value: "111", source: "assassins" },
      { key: "groupme.id", slot: "222", value: "222", source: "assassins" },
    ]);
    retractFact("1", "groupme.id", "assassins", "111");

    expect(
      factsFor("1")
        .filter((f) => f.key === "groupme.id")
        .map((f) => f.value),
    ).toEqual(["222"]);
  });

  test("or all of them at once, without knowing what they were", () => {
    assertFacts("1", [
      { key: "groupme.id", slot: "111", value: "111", source: "assassins" },
      { key: "groupme.id", slot: "222", value: "222", source: "assassins" },
    ]);

    expect(retractEvery("1", "groupme.id", "assassins")).toBe(2);
    expect(factsFor("1").filter((f) => f.key === "groupme.id")).toHaveLength(0);
  });

  test("a slotless assertion over slotted ones is refused, not obeyed", () => {
    assertFacts("1", [{ key: "groupme.id", slot: "111", value: "111", source: "assassins" }]);

    // Silently replacing both would lose an identity mapping somebody worked out.
    expect(() =>
      assertFacts("1", [{ key: "groupme.id", value: "333", source: "assassins" }]),
    ).toThrow(/pass a slot/);
    expect(factsFor("1").filter((f) => f.key === "groupme.id")).toHaveLength(1);
  });

  test("and the other way round, so a single value is never split by accident", () => {
    assertFacts("1", [{ key: "16p.type", value: "INTJ", source: "survey" }]);
    expect(() =>
      assertFacts("1", [{ key: "16p.type", slot: "x", value: "ENFP", source: "survey" }]),
    ).toThrow(/retract it before giving it slots/);
  });

  test("a different source is free to do it its own way", () => {
    assertFacts("1", [{ key: "groupme.id", slot: "111", value: "111", source: "assassins" }]);
    assertFacts("1", [{ key: "groupme.id", value: "999", source: "manual" }]);

    expect(factsFor("1").filter((f) => f.key === "groupme.id")).toHaveLength(2);
  });
});
