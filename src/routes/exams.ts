/** Finals: the registrar's exam table, and what it means for a section. */

import { json, notFound, q } from "../lib/http";
import { defaultExamTerm, examsForSections } from "../model/exams";
import { examSchedule, examTerms } from "../store/exams";
import type { RouteDef } from "./types";

export const examRoutes: RouteDef[] = [
  {
    method: "GET",
    path: "/v1/exams",
    tag: "catalog",
    summary: "The final exam schedule for a term, and optionally the exams of named sections",
    query: [
      {
        name: "term",
        description: "Term code. Defaults to the current one, then the newest published.",
      },
      {
        name: "section",
        description: "Section name, e.g. EGCP-1010-01. Repeatable, or comma separated.",
      },
    ],
    handler: (_request, url) => {
      const term = q(url, "term") ?? defaultExamTerm();
      if (!term) throw notFound("no exam schedule collected yet — run `engine collect exams`");
      const schedule = examSchedule(term);
      if (!schedule)
        throw notFound(`no exam schedule for ${term}; held: ${examTerms().join(", ")}`);
      const names = url.searchParams
        .getAll("section")
        .flatMap((value) => value.split(","))
        .map((name) => name.trim())
        .filter(Boolean);
      return json({
        ...schedule,
        terms: examTerms(),
        ...(names.length ? { exams: examsForSections(term, names) ?? [] } : {}),
      });
    },
  },
];
