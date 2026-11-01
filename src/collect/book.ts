/**
 * The printed academic catalog, crawled and read as data.
 *
 * Ported from the-cedarville-app, where this began. Colleague publishes what a
 * degree requires but not the arithmetic behind it; the book publishes both,
 * and its per-page course lists are also the vocabulary the major model scores
 * against. Two jobs, one source.
 *
 * The book lives on FlippingBook: a plain-HTML page per page of the
 * publication, no PDF, no feed. So this parses a printed layout rather than a
 * data format, and hangs every rule off the dot leaders, which are the one
 * thing the typesetting is reliable about.
 */

/** A `Label.........12.5` line, or `Label......0–4` when it is a range. */
export interface SummaryLine {
  label: string;
  min: number;
  /** Equal to `min` unless the catalog printed a range. */
  max: number;
}

/** A footnote saying a course pays for a general education slot as well. */
export interface DoubleCount {
  /** "GBIO-1000". */
  course: string;
  /** "biological science", as the catalog words it. */
  requirement: string;
}

export interface SequenceEntry {
  /** "CS-1210", or undefined for a placeholder like "History Elective". */
  code?: string;
  text: string;
  credits: number;
}

export interface SequenceYear {
  /** 1-4, occasionally 5. */
  year: number;
  entries: SequenceEntry[];
  /** The catalog's own total for the year, for checking our parse. */
  total?: number;
}

export interface ProgramPage {
  /** Page number within the book, which is also its URL segment. */
  page: number;
  title: string;
  summary: SummaryLine[];
  doubleCounts: DoubleCount[];
  sequence: SequenceYear[];
  /** Every course code named anywhere on the page. Used to match programs. */
  courses: string[];
  /**
   * The school the book files the program under. Only the graduate edition
   * says so in a form worth reading; the undergraduate pages leave it unset.
   */
  school?: string;
}

/**
 * Cedarville prints two catalogs a year. The undergraduate one is the book the
 * rest of this file was written against; the graduate one shares its
 * publisher and page format but none of its layout conventions.
 */
export type Edition = "undergraduate" | "graduate";
export const EDITIONS: Edition[] = ["undergraduate", "graduate"];

const COURSE = /\b[A-Z]{2,5}-\d{4}[A-Z]?\b/g;
/** Four or more dot leaders, then a number, optionally a range. */
const LEADER = /([A-Za-z][^.\n]*?)\.{4,}\s*(\d+(?:\.\d+)?)(?:\s*[–—-]\s*(\d+(?:\.\d+)?))?/g;
/**
 * A footnote marker sits flush against the course code — `3GBIO-1000` — while
 * a credit value is always separated by a space. That gap is the only thing
 * telling the two apart.
 */
const MARKED = /(?:^|\s)(\d)([A-Z]{2,5}-\d{4}[A-Z]?)\b/g;
const FOOTNOTE = /(?:^|\s)(\d)\s?Satisfies (?:the )?(.+?)(?: elective)? general education/g;
const YEAR_HEADS = ["First", "Second", "Third", "Fourth", "Fifth"];
const TOTAL = /^Total\b/i;
const GEN_ED = /^General Education/i;
const PROFICIENCY = /^Proficiency/i;
/**
 * A word that can belong to a program heading: capitalised, a dash, or one of
 * the few lowercase connectors real names use ("Bachelor of Music Education").
 */
const HEADING_WORD = /^(?:[A-Z(][A-Za-z'’()/&,-]*|[—–-]+|of|and|for|the|in|with|a|an)$/;

/** FlippingBook emits one word per element; collapse it back to a paragraph. */
function flatten(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

function slice(text: string, from: string, until: string[]): string | undefined {
  const start = text.indexOf(from);
  if (start < 0) return undefined;
  const rest = text.slice(start + from.length);
  const end = until
    .map((u) => rest.indexOf(u))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  return end === undefined ? rest : rest.slice(0, end);
}

/**
 * Every `Label.....n` line, stopping after the `Total`.
 *
 * Stopping matters more than it sounds. On about a third of the pages the
 * summary is followed immediately by the program's full requirement list, set
 * in the same dot-leader style, and reading on turns a 128-credit degree into
 * a 441-credit one. The Total line is the only structural end marker the
 * layout offers, and it is the last line of every summary block.
 */
function leaders(text: string, stopAtTotal = false): SummaryLine[] {
  const lines: SummaryLine[] = [];
  for (const m of text.matchAll(LEADER)) {
    const label = (m[1] ?? "").replace(/\s+/g, " ").trim();
    const min = Number(m[2]);
    // A trailing range only counts when the catalog printed one; "0–4" is a
    // range, but "128 A complete description" is a total followed by prose.
    const max = m[3] === undefined ? min : Number(m[3]);
    if (!label) continue;
    lines.push({ label, min, max: Math.max(min, max) });
    if (stopAtTotal && TOTAL.test(label)) break;
  }
  return lines;
}

/**
 * The program's name, taken from the Curriculum Summary heading.
 *
 * The page's own display title is unusable: FlippingBook interleaves the
 * characters of headline text set in two columns, so page 151 reads
 * "C o mB pa cuht e rl oErnogfi nSecei er in cge". The summary heading is body
 * text and survives intact.
 */
function titleOf(text: string, at: number): string {
  // Take trailing words while they still look like a heading, rather than
  // cutting at a delimiter. Headings are Title Case, and whatever precedes
  // them — a footnote legend, the end of a sentence, a credit value — is not.
  const words = text
    .slice(Math.max(0, at - 120), at)
    .trim()
    .split(/\s+/);
  const heading: string[] = [];
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i];
    if (!word || !HEADING_WORD.test(word)) break;
    heading.unshift(word);
  }
  return (
    heading
      .join(" ")
      .replace(/^[.\s*]+/, "")
      .trim()
      // "*Capstone Course" legends butt straight against the heading, and the
      // star has already been dropped as a non-heading word.
      .replace(/^(?:Capstone )?Courses?(?: for .+? program)?\s+/i, "")
      .replace(/\s+Major$/, "")
      .trim()
  );
}

function sequenceOf(text: string): SequenceYear[] {
  const body = slice(text, "Suggested Four-Year Curriculum", ["Made with FlippingBook"]);
  if (!body) return [];

  const years: SequenceYear[] = [];
  for (const [index, head] of YEAR_HEADS.entries()) {
    const chunk = slice(
      body,
      `${head} Year:`,
      YEAR_HEADS.slice(index + 1).map((h) => `${h} Year:`),
    );
    if (!chunk) continue;

    const entries: SequenceEntry[] = [];
    let total: number | undefined;
    // Same reasoning as the summary: the final year runs straight into the
    // footer and the next program, so the printed Total ends the year.
    for (const line of leaders(chunk, true)) {
      if (TOTAL.test(line.label)) {
        total = line.min;
        break;
      }
      entries.push({
        code: line.label.match(COURSE)?.[0],
        text: line.label,
        credits: line.min,
      });
    }
    if (entries.length) years.push({ year: index + 1, entries, total });
  }
  return years;
}

/** Parse one catalog page, or return undefined when it is not a program page. */
export function parseProgramPage(page: number, html: string): ProgramPage | undefined {
  const text = flatten(html);
  const at = text.indexOf("Curriculum Summary");
  if (at < 0) return undefined;

  const summary = leaders(
    slice(text, "Curriculum Summary", [
      "A complete description",
      "Suggested Four-Year",
      "Made with FlippingBook",
    ]) ?? "",
    true,
  );
  // Without a Total there is nothing to check a plan against, and the block is
  // more likely a requirement list that happened to follow the heading.
  if (!summary.some((l) => TOTAL.test(l.label))) return undefined;

  // Footnote markers and their definitions are far apart on the page, so pair
  // them by number rather than position.
  const meanings = new Map(
    [...text.matchAll(FOOTNOTE)].map(
      (m) => [m[1] ?? "", (m[2] ?? "").replace(/\s+/g, " ").trim()] as const,
    ),
  );
  const doubleCounts: DoubleCount[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MARKED)) {
    const course = m[2];
    const requirement = meanings.get(m[1] ?? "");
    if (!course || !requirement || seen.has(course)) continue;
    seen.add(course);
    doubleCounts.push({ course, requirement });
  }

  return {
    page,
    title: titleOf(text, at),
    summary,
    doubleCounts,
    sequence: sequenceOf(text),
    courses: [...new Set(text.match(COURSE) ?? [])].sort(),
  };
}

// ---- reading the summary -------------------------------------------------

/** The degree's stated minimum, which is the floor a plan must clear. */
export function totalCredits(program: ProgramPage): number | undefined {
  return program.summary.find((l) => TOTAL.test(l.label))?.min;
}

/**
 * How far a plan may exceed the degree minimum before it is a modelling bug.
 *
 * A plan can legitimately run over: proficiency requirements sit outside the
 * total, and a student may hold courses that fit nowhere. It cannot
 * legitimately run over by more than the summary's own slack, so this gives a
 * ceiling worth asserting against.
 */
export function creditCeiling(program: ProgramPage): number | undefined {
  const total = totalCredits(program);
  if (total === undefined) return undefined;
  // Proficiency is the one range that must not widen the ceiling: the total
  // says so itself, "minimum, not including proficiency".
  const slack = program.summary
    .filter((l) => !TOTAL.test(l.label) && !PROFICIENCY.test(l.label))
    .reduce((n, l) => n + (l.max - l.min), 0);
  return total + slack;
}

/**
 * Credits the catalog says are counted twice, and so must not be scheduled
 * twice. Only where the registrar footnoted it: 21 of the 76 program pages in
 * the 2025-26 book do, and cyber operations is not among them.
 */
export function absorbed(program: ProgramPage, credits: (code: string) => number): number {
  return program.doubleCounts.reduce((n, d) => n + credits(d.course), 0);
}

/** Whether the general education line was reduced, which implies double counts. */
export function genEdCredits(program: ProgramPage): number | undefined {
  return program.summary.find((l) => GEN_ED.test(l.label))?.min;
}

/**
 * Credits that must be counted twice for the summary's own arithmetic to work.
 *
 * The footnotes only cover 7 of 75 programs, but the summary gives the same
 * fact away by construction: when the parts sum past the stated total, the
 * difference is coursework filling two slots at once. Middle Childhood
 * Education lists 138.5 credits of parts against a 133-credit degree, and
 * that 5.5 is real overlap the registrar never footnoted.
 *
 * Zero means the catalog claims no overlap — which is itself worth knowing.
 * Cyber operations reports zero, so a plan for it that exceeds the total is
 * over-scheduling rather than double-counting.
 */
export function impliedOverlap(program: ProgramPage): number {
  const total = totalCredits(program);
  if (total === undefined) return 0;
  const parts = program.summary
    .filter((l) => !TOTAL.test(l.label) && !PROFICIENCY.test(l.label))
    .reduce((n, l) => n + l.min, 0);
  return Math.max(0, parts - total);
}

// ---- matching a page to a Colleague program ------------------------------

/**
 * Which catalog page describes a program, judged by the courses it names.
 *
 * Titles are the obvious key and the wrong one. Colleague calls the program
 * "BS Cyber Operations" and the catalog "Cyber Operations — Bachelor of
 * Science"; worse, several programs share a page with a track that differs
 * only in a parenthetical. Course lists collide far less often, and a student
 * on any program gets the same treatment without a lookup table.
 */
export function matchProgram(
  pages: readonly ProgramPage[],
  required: ReadonlySet<string>,
): ProgramPage | undefined {
  if (!required.size) return undefined;

  let best: { page: ProgramPage; score: number } | undefined;
  for (const page of pages) {
    const shared = page.courses.filter((c) => required.has(c)).length;
    // Jaccard rather than raw overlap: a page listing every course in the book
    // would otherwise beat the page that actually describes the program.
    const score = shared / (page.courses.length + required.size - shared);
    if (!best || score > best.score) best = { page, score };
  }
  // Below this the "match" is a handful of shared general-education courses,
  // which every program in the book has.
  return best && best.score >= 0.25 ? best.page : undefined;
}

// ---- crawling the book ---------------------------------------------------

/** "2025-2026". Both halves are full years, and they must be consecutive. */
export type CatalogYear = string;

export interface BookProgress {
  page: number;
  pages: number;
  programs: number;
}

export interface BookOptions {
  /** Gap between pages. This is a publisher, not a load test. */
  delayMs?: number;
  onProgress?: (progress: BookProgress) => void;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface Book {
  year: CatalogYear;
  edition: Edition;
  pages: number;
  programs: ProgramPage[];
  fetchedAt: string;
}

const BASE = "https://publications.cedarville.edu/academiccatalogs";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The graduate book sits one directory down from the undergraduate one. */
const bookUrl = (year: CatalogYear, edition: Edition) =>
  `${BASE}/${edition === "graduate" ? "graduate/" : ""}${year}`;

export const pageUrl = (year: CatalogYear, page: number, edition: Edition = "undergraduate") =>
  `${bookUrl(year, edition)}/${page}/`;

export const tocUrl = (year: CatalogYear, edition: Edition = "undergraduate") =>
  `${bookUrl(year, edition)}/toc/`;

/**
 * Strip a page to its text.
 *
 * FlippingBook emits the body one word per element, so tags collapse to
 * whitespace and the paragraph comes back intact. Scripts and styles have to
 * go first or their contents land in the text.
 */
export function textOf(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ");
}

/**
 * How many pages the book has, read from the navigation.
 *
 * Every page links to the last page as its "jump to end" control, so the
 * largest page reference on page one is the page count. Catalogs have run
 * between 320 and 352 pages, so nothing here should be hard-coded.
 */
export async function pageCount(
  year: CatalogYear,
  get: typeof globalThis.fetch = fetch,
  edition: Edition = "undergraduate",
): Promise<number> {
  const html = await (await get(pageUrl(year, 1, edition))).text();
  const refs = [...html.matchAll(/href="\.\.\/(\d+)\/"/g)].map((m) => Number(m[1]));
  const most = Math.max(0, ...refs);
  if (!most) throw new Error(`no page navigation found for the ${edition} catalog ${year}`);
  return most;
}

// ---- the graduate edition --------------------------------------------------

export interface TocEntry {
  page: number;
  title: string;
}

/** Every heading in FlippingBook's table of contents, in book order. */
export function parseToc(html: string): TocEntry[] {
  return [...html.matchAll(/<a[^>]*href="\.\.\/(\d+)\/"[^>]*>([^<]*)<\/a>/g)]
    .map((m) => ({
      page: Number(m[1]),
      title: textOf(m[2] ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    }))
    .filter((entry) => entry.title && !/^\d+$/.test(entry.title));
}

/**
 * A heading that opens a degree or certificate.
 *
 * The contents are flat: "Master of Divinity" and its "Program Delivery" sit at
 * the same level, so programs are recognised by how they are named. Combined
 * degrees are announced by their requirements heading, since that is the only
 * entry that names both halves.
 */
const PROGRAM =
  /^(?:(?:Accelerated |Advanced )?(?:Master|Doctor)|Graduate Certificate|MSN\b)|Combined Degree Course Requirements$/;
/** Named like a program, but an overview of the ones that follow it. */
const NOT_PROGRAM = /Pathways$/;
/** A heading that ends whatever program came before it without starting one. */
const BOUNDARY =
  /\bSchool of\b|^(?:Cedarville Theological Seminary|Combined Degree Programs?|Academic Schools)$|Faculty$|Course Descriptions$/;
/** "Robert W. Plaster School of Business" is a school; its faculty list is not. */
const SCHOOL = /^(?!.*Faculty$)(?:.*\bSchool of\b.*|Cedarville Theological Seminary)$/;
const DESCRIPTIONS = /Course Descriptions$/;

/** The registrar files the seminary under the school that houses it. */
const SCHOOL_ALIASES: Record<string, string> = {
  "Cedarville Theological Seminary": "School of Biblical and Theological Studies",
};

/** Contents headings, tidied into the names the rest of the engine uses. */
export function graduateTitle(heading: string): string {
  return heading
    .replace(/\s*\(In Teach-Out\)\s*$/i, "")
    .replace(/\s+Combined Degree Course Requirements$/, " Combined Degree")
    .replace(/^MSN\s*[–—-]\s*(.+?)(?:\s+Track)?$/, "MSN, $1")
    .replace(/^(Doctor of Nursing Practice) Program(?::\s*(.+))?$/, (_, degree, path) =>
      path ? `${degree}, ${path}` : degree,
    )
    .trim();
}

export interface GraduateSpan {
  heading: string;
  title: string;
  school: string | undefined;
  /** First and last page the program's text runs across, inclusive. */
  start: number;
  end: number;
  /** The heading that closes the span, when it shares the span's last page. */
  until: string | undefined;
}

/**
 * Cut the contents into one span of pages per program.
 *
 * A program runs from its heading to the next program or boundary heading,
 * and several can share a page: the combined degrees stack four to a page. So
 * a span also carries the heading that ends it when that heading lands on the
 * same page, and the text is cut there rather than at the page break.
 */
export function graduateSpans(toc: TocEntry[]): GraduateSpan[] {
  const opening = toc.findIndex((entry) => entry.title === "Academic Schools");
  const body = opening < 0 ? toc : toc.slice(opening);
  const closing = body.findIndex((entry) => DESCRIPTIONS.test(entry.title));
  const headings = (closing < 0 ? body : body.slice(0, closing + 1)).filter(
    (entry) =>
      (PROGRAM.test(entry.title) && !NOT_PROGRAM.test(entry.title)) || BOUNDARY.test(entry.title),
  );

  const spans: GraduateSpan[] = [];
  let school: string | undefined;
  for (const [index, entry] of headings.entries()) {
    if (SCHOOL.test(entry.title)) school = SCHOOL_ALIASES[entry.title] ?? entry.title;
    if (BOUNDARY.test(entry.title)) continue;
    const next = headings[index + 1];
    const sharesPage = next !== undefined && next.page === entry.page;
    // The next heading's page is where this program's text runs out. A program
    // ending on the page before it ends at that page break; one ending on a
    // later page is cut at the heading itself.
    const end = next ? Math.max(entry.page, sharesPage ? next.page : next.page - 1) : entry.page;
    spans.push({
      heading: entry.title,
      title: graduateTitle(entry.title),
      school,
      start: entry.page,
      end,
      until: next && next.page === end ? next.title : undefined,
    });
  }
  return spans;
}

/**
 * The span's text, cut at its own heading and at the one that ends it.
 *
 * A heading missing from the text, because the typesetting broke it across
 * elements, costs only precision: the cut falls back to the page edge.
 */
export function spanText(span: GraduateSpan, pages: Map<number, string>): string {
  const parts: string[] = [];
  for (let page = span.start; page <= span.end; page++) {
    let text = (pages.get(page) ?? "").replace(/\s+/g, " ");
    let from = 0;
    if (page === span.start) {
      from = Math.max(0, text.indexOf(span.heading));
      text = text.slice(from);
    }
    if (page === span.end && span.until) {
      const at = text.indexOf(span.until, page === span.start ? span.heading.length : 0);
      if (at >= 0) text = text.slice(0, at);
    }
    parts.push(text);
  }
  return parts.join(" ");
}

/** One graduate program, read off its span of text. */
export function parseGraduateProgram(span: GraduateSpan, text: string): ProgramPage | undefined {
  const courses = [...new Set(text.match(COURSE) ?? [])].sort();
  if (!courses.length) return undefined;

  // The graduate book prints its totals as "... Summary" blocks, one per track
  // when a degree has tracks. The first is the degree as most students take it.
  const at = text.search(/\bSummary\b/);
  const summary = leaders(at >= 0 ? text.slice(at) : text, true);
  return {
    page: span.start,
    title: span.title,
    summary: summary.some((line) => TOTAL.test(line.label)) ? summary : [],
    doubleCounts: [],
    sequence: [],
    courses,
    school: span.school,
  };
}

/**
 * Programs named by more than one heading, merged into one.
 *
 * The combined degrees are printed once under each school that shares them,
 * and two programs with the same title would be the same program counted
 * twice by everything downstream.
 */
export function mergePrograms(programs: ProgramPage[]): ProgramPage[] {
  const byTitle = new Map<string, ProgramPage>();
  for (const program of programs) {
    const seen = byTitle.get(program.title);
    if (!seen) {
      byTitle.set(program.title, program);
      continue;
    }
    seen.courses = [...new Set([...seen.courses, ...program.courses])].sort();
    if (!seen.summary.length) seen.summary = program.summary;
  }
  return [...byTitle.values()];
}

// ---- crawling ----------------------------------------------------------------

async function crawlUndergraduate(year: CatalogYear, options: BookOptions): Promise<Book> {
  const { delayMs = 150, onProgress, signal, fetch: get = fetch } = options;
  const pages = await pageCount(year, get);
  const programs: ProgramPage[] = [];

  for (let page = 1; page <= pages; page++) {
    signal?.throwIfAborted();
    const response = await get(pageUrl(year, page), { signal });
    // A gap in the book is not a reason to abandon the rest of it.
    if (response.ok) {
      const program = parseProgramPage(page, textOf(await response.text()));
      if (program) programs.push(program);
    }
    onProgress?.({ page, pages, programs: programs.length });
    if (page < pages && delayMs) await sleep(delayMs);
  }

  return {
    year,
    edition: "undergraduate",
    pages,
    programs,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * The graduate book, read through its contents.
 *
 * Its program pages share no layout the undergraduate parser can hang off: a
 * third have a Curriculum Summary, the rest spread one degree across five
 * pages of tracks and suggested semesters. What every program does have is a
 * contents entry, so the contents decide where each one starts and stops, and
 * only the pages inside a program are fetched at all.
 */
async function crawlGraduate(year: CatalogYear, options: BookOptions): Promise<Book> {
  const { delayMs = 150, onProgress, signal, fetch: get = fetch } = options;
  const contents = await get(tocUrl(year, "graduate"), { signal });
  if (!contents.ok) throw new Error(`no graduate catalog for ${year} (${contents.status})`);
  const spans = graduateSpans(parseToc(await contents.text()));
  if (!spans.length) throw new Error(`no programs in the graduate contents for ${year}`);

  const wanted = [...new Set(spans.flatMap((s) => range(s.start, s.end)))].sort((a, b) => a - b);
  const pages = new Map<number, string>();
  for (const [index, page] of wanted.entries()) {
    signal?.throwIfAborted();
    const response = await get(pageUrl(year, page, "graduate"), { signal });
    if (response.ok) pages.set(page, textOf(await response.text()));
    onProgress?.({ page: index + 1, pages: wanted.length, programs: spans.length });
    if (index < wanted.length - 1 && delayMs) await sleep(delayMs);
  }

  const programs = mergePrograms(
    spans.flatMap((span) => parseGraduateProgram(span, spanText(span, pages)) ?? []),
  );
  return {
    year,
    edition: "graduate",
    pages: wanted.length,
    programs,
    fetchedAt: new Date().toISOString(),
  };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Read one edition of a catalog year, keeping only what describes a program. */
export function crawlBook(
  year: CatalogYear,
  options: BookOptions & { edition?: Edition } = {},
): Promise<Book> {
  return options.edition === "graduate"
    ? crawlGraduate(year, options)
    : crawlUndergraduate(year, options);
}
