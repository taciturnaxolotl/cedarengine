/**
 * Fetching a term of the course catalog, once, for everybody.
 *
 * Ported from the-cedarville-app. A single search in SectionListing view
 * returns sections directly, so a term is about sixty pages rather than one
 * request per course. The same term again in CatalogListing view is the only
 * place requisites come back as readable text rather than an opaque rule id.
 *
 * No session is involved: the guest course-search endpoints are what the
 * signed-out search page itself calls, and nothing personal is reachable from
 * them. As of October 2026 those endpoints redirect to SSO, so this crawler
 * fails without a session; the extension runs the same searches signed in and
 * hands the results to `fileCrawl`.
 */

import { ALL_COURSES, replaceTerm, writeRule } from "../store/catalog";
import { GuestColleague, resolveGroup } from "./colleague";

export interface CrawlProgress {
  term: string;
  page: number;
  pages: number;
  items: number;
  phase: "sections" | "courses";
}

export interface CrawlOptions {
  /** Gap between pages. This is a registrar, not a load test. */
  delayMs?: number;
  onProgress?: (progress: CrawlProgress) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Walks every page of one search, calling back as it goes. */
async function pages(
  client: GuestColleague,
  criteria: Parameters<GuestColleague["search"]>[0],
  options: CrawlOptions,
  onPage: (result: Awaited<ReturnType<GuestColleague["search"]>>) => number,
): Promise<void> {
  const { delayMs = 300, onProgress, signal } = options;
  const phase = criteria.searchResultsView === "CatalogListing" ? "courses" : "sections";
  let page = 1;
  let total = 1;

  while (page <= total) {
    if (signal?.aborted) return;
    const result = await client.search({ ...criteria, pageNumber: page });
    total = Math.max(result.TotalPages ?? 1, 1);
    const items = onPage(result);
    onProgress?.({ term: criteria.terms?.[0] ?? ALL_COURSES, page, pages: total, items, phase });
    page++;
    if (page <= total && delayMs > 0) await sleep(delayMs);
  }
}

export async function crawlTerm(
  term: string,
  options: CrawlOptions = {},
  client = new GuestColleague(),
): Promise<{ sections: number; courses: number }> {
  const sections: any[] = [];
  const seen = new Set<string>();
  await pages(client, { terms: [term] }, options, (result) => {
    for (const raw of result.Sections ?? []) {
      const section = raw as { Id?: string };
      // A section shifting between pages mid-crawl must not double up.
      if (!section?.Id || seen.has(section.Id)) continue;
      seen.add(section.Id);
      sections.push(section);
    }
    return sections.length;
  });

  const courses = await crawlCourses(term, options, client);
  return fileCrawl(term, sections, courses);
}

/**
 * File one crawl, whoever fetched it: this crawler, or the extension doing the
 * same search with a signed-in session.
 *
 * The every-course listing is deduplicated by code first. A term crawl that
 * comes back with no sections means something went wrong upstream, and
 * keeping the previous catalog beats replacing a working timetable with
 * nothing.
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

export async function crawlCourses(
  term: string,
  options: CrawlOptions = {},
  client = new GuestColleague(),
): Promise<any[]> {
  const byId = new Map<string, any>();
  await pages(client, { terms: [term], searchResultsView: "CatalogListing" }, options, (result) => {
    for (const raw of result.CourseFullModels ?? []) {
      const course = raw as { Id?: string };
      if (course?.Id) byId.set(course.Id, course);
    }
    return byId.size;
  });
  return [...byId.values()];
}

/**
 * Every course in the catalog, whether or not it runs this year.
 *
 * The per-term crawl answers "what is offered"; this answers "what exists".
 * They have to be separate, because a prerequisite is often a course nobody is
 * teaching this year — build the graph from term data alone and it loses a
 * third of its prerequisite nodes.
 */
export async function crawlAllCourses(
  options: CrawlOptions = {},
  client = new GuestColleague(),
): Promise<number> {
  const byId = new Map<string, any>();
  await pages(client, { searchResultsView: "CatalogListing" }, options, (result) => {
    for (const raw of result.CourseFullModels ?? []) {
      const course = raw as { Id?: string };
      if (course?.Id) byId.set(course.Id, course);
    }
    return byId.size;
  });

  return fileCrawl(ALL_COURSES, [], [...byId.values()]).courses;
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

/** Every term Colleague currently lists as searchable. */
export const availableTerms = (client = new GuestColleague()) => client.terms();

/**
 * Resolve one requirement group's course list and file it.
 *
 * This is the escape hatch for everything a degree evaluation refuses to
 * enumerate: a group whose eligible courses hide behind an opaque rule still
 * has an identity — requirement, subrequirement, group — and the course search
 * accepts exactly that triple.
 */
export async function collectRule(
  key: { requirement: string; subrequirement: string; group: string },
  client = new GuestColleague(),
): Promise<string[]> {
  const courses = await resolveGroup(key, client);
  writeRule(key, courses);
  return courses;
}
