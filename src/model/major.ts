/**
 * Guessing a major from a booklist.
 *
 * Programs and students both become IDF-weighted course vectors, ranked by
 * cosine similarity. The weighting is the whole idea: a course that appears in
 * many programs (every gen-ed) carries almost no signal, while one that
 * appears in two or three names the major nearly on its own.
 *
 * From a single term of mostly-shared coursework this is a reliable cluster
 * classifier and a weak fine-grained one — it cannot split MechE from CompE
 * when they share the freshman core. Accumulating terms is the fix, and the
 * metrics table exists to watch that climb.
 */

import { EDITIONS, type Edition } from "../collect/book";
import { latestYear, programVocabulary } from "../store/programs";

export interface Guess {
  title: string;
  score: number;
}

export interface Ranking {
  ranked: Guess[];
  /** How many of the student's courses are distinctive enough to matter. */
  signal: number;
}

export interface MajorModel {
  year: string;
  programCount: number;
  guess: (courses: Iterable<string>) => Ranking;
}

/** A course this distinctive is doing real work rather than being a gen-ed. */
const SIGNAL_IDF = 2.0;

const cleanTitle = (title: string) =>
  title
    .replace(/^for\s+/i, "")
    .replace(/\b(\w+)\s+\1\b/gi, "$1")
    .trim();

/** One edition's programs as IDF-weighted vectors, and the ranking against them. */
function scorer(programs: { title: string; courses: string[] }[]) {
  const count = programs.length;

  const df = new Map<string, number>();
  for (const program of programs) {
    for (const course of new Set(program.courses)) df.set(course, (df.get(course) ?? 0) + 1);
  }
  const idf = (course: string) => Math.log((count + 1) / ((df.get(course) ?? 0) + 1)) + 1;

  const vectors = programs.map((program) => {
    const weights = new Map<string, number>();
    for (const course of new Set(program.courses)) weights.set(course, idf(course));
    return {
      title: cleanTitle(program.title),
      weights,
      norm: Math.hypot(...weights.values()),
    };
  });

  return (courses: Iterable<string>): Ranking => {
    const student = new Map<string, number>();
    for (const course of courses) student.set(course, idf(course));
    const norm = Math.hypot(...student.values());
    const signal = [...student.keys()].filter((c) => df.has(c) && idf(c) > SIGNAL_IDF).length;
    if (!norm) return { ranked: [], signal: 0 };

    // A program sharing no course with the booklist scores zero, and a list of
    // zeros sorts into catalog order, which reads as a guess and is not one.
    // A booklist of courses the book never lists would otherwise be handed
    // whatever program happened to be printed first.
    const ranked = vectors
      .map((program) => {
        if (!program.norm) return { title: program.title, score: 0 };
        let dot = 0;
        for (const [course, weight] of student) {
          const other = program.weights.get(course);
          if (other) dot += weight * other;
        }
        return { title: program.title, score: dot / (norm * program.norm) };
      })
      .filter((program) => program.score > 0)
      .sort((a, b) => b.score - a.score);

    return { ranked, signal };
  };
}

/** Cedarville numbers graduate courses from 5000 up: BTAT-6410, NSG-8010. */
const GRADUATE_LEVEL = /-[5-9]\d{3}[A-Z]?$/;

/**
 * Which book a booklist should be read against.
 *
 * Mostly graduate-level courses mean a graduate student, whatever the directory
 * calls them. The two books are scored separately rather than pooled because
 * pooling changes the weights: forty extra programs shift every course's
 * rarity, and undergraduates who never touch a graduate course get reranked by
 * programs they cannot be in.
 */
export function editionFor(courses: Iterable<string>): Edition {
  const codes = [...courses];
  const graduate = codes.filter((code) => GRADUATE_LEVEL.test(code)).length;
  return graduate * 2 > codes.length ? "graduate" : "undergraduate";
}

export function buildModel(year: string): MajorModel {
  const programs = programVocabulary(year);
  const books = new Map<Edition, ReturnType<typeof scorer>>();
  for (const edition of EDITIONS) {
    const shelf = programs.filter((p) => p.edition === edition);
    if (shelf.length) books.set(edition, scorer(shelf));
  }

  const guess = (courses: Iterable<string>): Ranking => {
    const codes = [...courses];
    // A year collected before the graduate book existed still answers, from
    // the undergraduate one, rather than answering nothing.
    const book = books.get(editionFor(codes)) ?? books.get("undergraduate");
    return book ? book(codes) : { ranked: [], signal: 0 };
  };

  return { year, programCount: programs.length, guess };
}

let cached: MajorModel | undefined;

/**
 * The model for a year, built once and kept. Rebuilding costs a scan of every
 * program page, and the vocabulary only changes when a catalog is collected.
 */
export function model(year?: string): MajorModel {
  const wanted = year ?? latestYear();
  if (!wanted) throw new Error("no catalog collected yet — run `engine collect book`");
  if (!cached || cached.year !== wanted) cached = buildModel(wanted);
  return cached;
}

/** Called after a book collection, so the next guess sees the new vocabulary. */
export const forgetModel = () => {
  cached = undefined;
};
