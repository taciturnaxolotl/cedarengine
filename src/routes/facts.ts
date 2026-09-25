/**
 * Facts: the half of a person the directory never knew.
 *
 * Everything here is keyed by the directory's student id, which is the only
 * identifier every source can agree on. That is also what makes the reverse
 * lookup worth having — an outside system holds a GroupMe id and needs a
 * person, and this is the one place that mapping is written down.
 */

import { badRequest, body, json, notFound, num, q, required } from "../lib/http";
import {
  assertFacts,
  factDistribution,
  factHistory,
  factKeys,
  factsFor,
  peopleWithFact,
  retractFact,
} from "../store/facts";
import { personById } from "../store/people";
import type { RouteDef } from "./types";

interface AssertBody {
  facts?: { key: string; value: unknown; slot?: string; source?: string }[];
  source?: string;
}

interface RetractBody {
  key?: string;
  source?: string;
  slot?: string;
}

/** A person has to exist before anything can be said about them. */
const requirePerson = (id: string) => {
  if (!personById(id)) throw notFound("no such person");
  return id;
};

export const factRoutes: RouteDef[] = [
  {
    method: "GET",
    path: "/v1/people/:id/facts",
    tag: "facts",
    summary: "Everything asserted about a person beyond the directory",
    query: [
      { name: "history", description: "Return the whole log, tombstones included" },
      { name: "limit", description: "History entries, default 200" },
    ],
    handler: (request, url) => {
      const id = requirePerson(request.params.id ?? "");
      if (["1", "true", "yes"].includes((q(url, "history") ?? "").toLowerCase())) {
        return json({ studentId: id, history: factHistory(id, num(url, "limit") ?? 200) });
      }
      return json({ studentId: id, facts: factsFor(id) });
    },
  },
  {
    method: "GET",
    path: "/v1/facts",
    tag: "facts",
    summary: "Who carries a fact, or how the population splits on one",
    query: [
      { name: "key", description: "Fact key, e.g. groupme.id or 16p.type", required: true },
      { name: "value", description: "Only people whose value matches. Omit for everyone." },
      {
        name: "distribution",
        description: "Counts per value instead of people. Meaningless for a photograph.",
      },
      { name: "limit", description: "People to return, default 50" },
    ],
    handler: (_request, url) => {
      const key = required(url, "key");
      if (["1", "true", "yes"].includes((q(url, "distribution") ?? "").toLowerCase())) {
        return json({ key, values: factDistribution(key) });
      }
      return json({
        key,
        people: peopleWithFact(key, q(url, "value"), num(url, "limit") ?? 50),
      });
    },
  },
  {
    method: "GET",
    path: "/v1/facts/keys",
    tag: "facts",
    summary: "Every fact key in the database, with how many people carry it",
    handler: () => json({ keys: factKeys() }),
  },
  {
    method: "POST",
    path: "/v1/people/:id/facts",
    tag: "facts",
    summary: "Assert facts about a person",
    body: '{ "source": "assassins", "facts": [{ "key": "groupme.id", "value": "12345" }] }',
    handler: async (request) => {
      const id = requirePerson(request.params.id ?? "");
      const payload = await body<AssertBody>(request);
      const facts = payload.facts ?? [];
      if (!facts.length) throw badRequest("facts must be a non-empty array");

      const prepared = facts.map((fact) => {
        if (!fact.key) throw badRequest("every fact needs a key");
        if (fact.value === undefined) throw badRequest(`fact "${fact.key}" has no value`);
        // Naming who said so is not paperwork. Two sources are allowed to
        // disagree here, and without a name the newer one silently wins.
        const source = fact.source ?? payload.source;
        if (!source) throw badRequest(`fact "${fact.key}" has no source`);
        return { key: fact.key, value: fact.value, slot: fact.slot, source };
      });

      return json({ studentId: id, written: assertFacts(id, prepared) });
    },
  },
  {
    method: "POST",
    path: "/v1/people/:id/facts/retract",
    tag: "facts",
    summary: "Withdraw a fact, by writing down that it is no longer claimed",
    body: '{ "key": "groupme.id", "source": "assassins", "slot": "" }',
    handler: async (request) => {
      const id = requirePerson(request.params.id ?? "");
      const payload = await body<RetractBody>(request);
      if (!payload.key || !payload.source) throw badRequest("key and source are both required");
      const retracted = retractFact(id, payload.key, payload.source, payload.slot ?? "");
      if (!retracted) throw notFound("nothing of that key and source is currently asserted");
      return json({ studentId: id, retracted: true });
    },
  },
];
