/**
 * Filing a crawl of the course catalog.
 *
 * The fetching used to live here too, against the anonymous course-search
 * endpoints. As of October 2026 Self-Service gates those behind a login, so the
 * crawl moved into the browser extension, which runs the same searches with a
 * signed-in session and posts the results to `/v1/sync/catalog`. What remains is
 * the part that does not need a session: turning one crawl into stored rows.
 */

import { ALL_COURSES, replaceTerm } from "../store/catalog";

/**
 * File one crawl, whoever fetched it.
 *
 * The every-course listing is deduplicated by code first. A term crawl that
 * comes back with no sections means something went wrong upstream, and keeping
 * the previous catalog beats replacing a working timetable with nothing.
 */
export function fileCrawl(
  term: string,
  sections: any[],
  courses: any[],
  fetchedAt = new Date().toISOString(),
): { sections: number; courses: number } {
  if (term === ALL_COURSES) {
    const unique = dedupeByCode(courses);
    if (unique.length) replaceTerm({ term, fetchedAt, sections: [], courses: unique });
    return { sections: 0, courses: unique.length };
  }
  if (!sections.length) return { sections: 0, courses: courses.length };
  replaceTerm({ term, fetchedAt, sections, courses });
  return { sections: sections.length, courses: courses.length };
}

/**
 * One record per course code, chosen deliberately.
 *
 * About 1% of codes carry two records: a course being retired beside its
 * replacement, both live during the transition. Requisite text only ever names
 * a code, so a graph keyed by code has to choose — prefer the one being
 * taught, then the one that states requisites.
 */
export function dedupeByCode(records: any[]): any[] {
  const best = new Map<string, any>();
  const score = (c: any) =>
    (c.MatchingSectionIds?.length ?? 0) * 10 + (c.CourseRequisites?.length ?? 0);

  for (const course of records) {
    const code = `${course.SubjectCode}-${course.Number}`;
    const held = best.get(code);
    if (!held || score(course) > score(held)) best.set(code, course);
  }
  return [...best.values()];
}
