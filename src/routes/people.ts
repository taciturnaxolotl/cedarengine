/** Who is here, where they live, what they are probably studying. */

import { bool, json, notFound, num, q } from "../lib/http";
import { guessFor } from "../model/guess";
import { scheduleFor } from "../model/schedule";
import { locate } from "../store/campus";
import { booklistTimeline, personTimeline } from "../store/history";
import { peopleStats, personById, searchPeople } from "../store/people";
import type { RouteDef } from "./types";

export const peopleRoutes: RouteDef[] = [
  {
    method: "GET",
    path: "/v1/people",
    tag: "people",
    summary: "Search the directory by name, dorm, department or population",
    query: [
      { name: "q", description: "Name. Two words are read as first then last." },
      { name: "dorm", description: "Dorm name, exact" },
      { name: "department", description: "Department description, exact" },
      { name: "type", description: "Student type: UG, UGO, GS, P4" },
      { name: "class", description: "Class: FR, SO, JR, SR" },
      { name: "gone", description: "Include people the directory has stopped listing" },
      {
        name: "fact.*",
        description: "Any fact, exactly: fact.16p.type=INTJ. See /v1/facts/keys for what exists.",
      },
      { name: "has", description: "A fact key they must carry, whatever it says. Repeatable." },
      { name: "limit", description: "1-500, default 25" },
      { name: "offset", description: "Rows to skip" },
    ],
    handler: (_request, url) => {
      // `fact.` is a prefix rather than a fixed list because the whole point of
      // the facts table is that nobody has to edit this file to add a key.
      const facts: Record<string, string> = {};
      for (const [name, value] of url.searchParams) {
        if (name.startsWith("fact.") && value) facts[name.slice("fact.".length)] = value;
      }

      return json({
        people: searchPeople({
          q: q(url, "q"),
          dorm: q(url, "dorm"),
          department: q(url, "department"),
          type: q(url, "type"),
          class: q(url, "class"),
          facts,
          has: url.searchParams.getAll("has").filter(Boolean),
          includeGone: bool(url, "gone"),
          limit: num(url, "limit"),
          offset: num(url, "offset"),
        }),
      });
    },
  },
  {
    method: "GET",
    path: "/v1/people/:id",
    tag: "people",
    summary: "One person by directory id",
    handler: (request) => {
      const person = personById(request.params.id ?? "");
      if (!person) throw notFound("no such person");
      return json(person);
    },
  },
  {
    method: "GET",
    path: "/v1/people/:id/major",
    tag: "people",
    summary: "Best guesses at a student's major, from their booklists",
    query: [
      { name: "top", description: "How many guesses, default 3" },
      { name: "year", description: "Catalog year to score against" },
    ],
    handler: (request, url) => {
      const guess = guessFor(request.params.id ?? "", num(url, "top") ?? 3, q(url, "year"));
      if (!guess) throw notFound("no booklist data for that person");
      return json(guess);
    },
  },
  {
    method: "GET",
    path: "/v1/people/:id/schedule",
    tag: "people",
    summary: "A student's week: the sections their booklist names, with times and rooms",
    query: [
      {
        name: "term",
        description: "Term code. Defaults to the current one, then the newest held.",
      },
    ],
    handler: (request, url) => {
      const schedule = scheduleFor(request.params.id ?? "", q(url, "term"));
      if (!schedule) throw notFound("no booklist data for that person");
      return json(schedule);
    },
  },
  {
    method: "GET",
    path: "/v1/people/:id/history",
    tag: "people",
    summary: "Everything that has changed about a person since we first saw them",
    query: [{ name: "limit", description: "Events to return, default 200" }],
    handler: (request, url) => {
      const id = request.params.id ?? "";
      if (!personById(id)) throw notFound("no such person");
      return json({
        directory: personTimeline(id, num(url, "limit")),
        booklists: booklistTimeline(id),
      });
    },
  },
  {
    method: "GET",
    path: "/v1/people/:id/location",
    tag: "people",
    summary: "The building a person is listed against, with coordinates",
    handler: (request) => {
      const where = locate(request.params.id ?? "");
      if (!where) throw notFound("no mapped building for that person");
      return json(where);
    },
  },
  {
    method: "GET",
    path: "/v1/dorms",
    tag: "people",
    summary: "Population by dorm",
    handler: () => json({ dorms: peopleStats().byDorm }),
  },
];
