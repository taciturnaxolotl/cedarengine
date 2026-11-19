/**
 * Greyball, applied to a caller rather than a person.
 *
 * A level-1 caller sees a plausible timetable instead of the real one for
 * anybody they look up, students and professors alike, with the exam page and
 * the booklist log to match; the directory record itself stays accurate. A
 * level-2 caller is a canary: the pipeline hands them `decoyResponse` and
 * nothing here runs. The levels arrive from the caller, which loaded them once
 * for the whole request.
 */

import { json, notFound, q } from "../lib/http";
import {
  generatedExamsFor,
  generatedScheduleFor,
  generatedTeachingFor,
} from "../model/decoy-schedule";
import type { Principal } from "./principal";

/**
 * The level that applies to this caller. A person greyballed by their indiko
 * account stays greyballed through every personal token they mint, since those
 * carry the same owner; a token can also be listed on its own. The stricter wins.
 */
export function greyballLevelFor(
  principal: Pick<Principal, "actor" | "owner">,
  levels: Map<string, 1 | 2>,
): 1 | 2 | null {
  const direct = levels.get(principal.actor) ?? 0;
  const owner = principal.owner ? (levels.get(`indiko:${principal.owner}`) ?? 0) : 0;
  return (Math.max(direct, owner) || null) as 1 | 2 | null;
}

/** The invented timetable a level-1 caller gets, or null to let the route answer for real. */
export function greyballResponse(
  route: string,
  url: URL,
  params: Record<string, string>,
): Response | null {
  const id = params.id;
  if (!id) return null;

  if (route === "/v1/people/:id/schedule") {
    const fake = generatedScheduleFor(id, q(url, "term"));
    if (!fake) throw notFound("no booklist data for that person");
    return json(fake);
  }
  if (route === "/v1/people/:id/teaching") {
    const fake = generatedTeachingFor(id, q(url, "term"));
    if (!fake) throw notFound("no sections list that person as an instructor");
    return json(fake);
  }
  if (route === "/v1/people/:id/exams") {
    const week = generatedExamsFor(id, q(url, "term"));
    if (!week) throw notFound("no booklist or teaching load for that person");
    if ("missing" in week) throw notFound(`no exam schedule collected for ${week.missing}`);
    return json(week);
  }
  return null;
}

/** Rewrites inside a real answer for a level-1 caller, before the role's masks strip fields. */
export function obscurePayload(route: string, body: unknown, level: 1 | 2 | null): unknown {
  // A booklist log names sections; level 1 hides timetables, so it hides the log too.
  if (route === "/v1/people/:id/history" && level === 1) {
    return { ...(body as object), booklists: [] };
  }
  return body;
}
