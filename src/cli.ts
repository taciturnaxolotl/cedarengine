#!/usr/bin/env bun

/**
 * The engine from a terminal.
 *
 *   bun run engine import                  seed from the older projects
 *   bun run engine collect directory       sweep the directory (needs a session)
 *   bun run engine collect catalog 2027SP  crawl a term (no session needed)
 *   bun run engine collect book            read the printed catalog
 *   bun run engine collect campus          fetch the map off OpenStreetMap
 *   bun run engine harvester 2027SP        write the booklist userscript
 *   bun run engine ingest ~/Downloads/2027SP.json
 *   bun run engine labels honors.csv       load known majors
 *   bun run engine evaluate                score the model, log the number
 *   bun run engine guess "First Last"      one person, or --all
 *   bun run engine stats
 */

import { writeFileSync } from "node:fs";
import { crawlBook } from "./collect/book";
import { collectCampus } from "./collect/campus";
import { availableTerms, collectRule, crawlAllCourses, crawlTerm } from "./collect/catalog";
import { sweepDirectory } from "./collect/directory";
import { buildHarvester, ingestFile } from "./collect/harvest";
import { importAll } from "./collect/import";
import { loadLabelsFile } from "./collect/labels";
import { toCSV } from "./lib/csv";
import { catalogYear, currentTerm } from "./lib/terms";
import { evaluate } from "./model/evaluate";
import { guessAll, guessFor } from "./model/guess";
import { forgetModel } from "./model/major";
import { buildings } from "./store/campus";
import { termStats } from "./store/catalog";
import { harvestTerms } from "./store/harvest";
import { recentSweeps } from "./store/history";
import { findByName, peopleStats } from "./store/people";
import { latestYear, programYears, replaceYear } from "./store/programs";

const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith("--"));
const flag = (name: string, fallback?: string) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const has = (name: string) => argv.includes(`--${name}`);

const tty = process.stderr.isTTY;
const ink = (code: string) => (text: string | number) =>
  tty ? `\x1b[${code}m${text}\x1b[0m` : String(text);
const dim = ink("2");
const bold = ink("1");
const pink = ink("38;5;212");
const blue = ink("38;5;75");
const n = (value: number) => value.toLocaleString("en-US");

const say = (label: string, value: string | number) =>
  console.error(`  ${dim(label.padEnd(16))} ${bold(value)}`);

/** Redraws one line in a terminal and says nothing at all when piped. */
const progress = (line: string) => {
  if (tty) process.stderr.write(`\r\x1b[2K  ${line}`);
};
const endProgress = () => {
  if (tty) process.stderr.write("\r\x1b[2K");
};

async function collect(what: string | undefined): Promise<void> {
  switch (what) {
    case "directory": {
      const result = await sweepDirectory({
        concurrency: Number(flag("concurrency", "4")),
        delayMs: Number(flag("delay", "120")),
        maxDepth: Number(flag("depth", "4")),
        refresh: has("refresh"),
        alsoFirst: has("also-first"),
        cookieFile: flag("cookie"),
        onProgress: (state) =>
          progress(
            `${pink(state.current)}  ${dim("queue")} ${n(state.queued)}  ` +
              `${dim("done")} ${n(state.done)}  ${n(state.added)} new  ${n(state.changed)} changed`,
          ),
      });
      endProgress();
      say("people seen", n(result.seen + result.added));
      say("new", n(result.added));
      say("changed", n(result.changed));
      if (result.complete) say("departed", n(result.vanished));
      say("requests", n(result.requests));
      say("elapsed", `${Math.round(result.elapsedMs / 1000)}s`);
      say(
        "coverage",
        result.complete ? "complete" : result.expired ? "session expired" : "partial",
      );
      if (!result.complete && !result.expired) {
        console.error(
          dim("  a partial sweep cannot retire anyone; pass --refresh to sweep from scratch"),
        );
      }
      return;
    }

    case "catalog": {
      if (has("terms")) {
        for (const term of await availableTerms()) console.log(`${term.code}\t${term.description}`);
        return;
      }
      if (has("all")) {
        const courses = await crawlAllCourses({
          onProgress: (p) =>
            progress(`${blue("every course")}  page ${p.page}/${p.pages}  ${n(p.items)}`),
        });
        endProgress();
        say("courses", n(courses));
        return;
      }
      // `collect` is dispatched with positional[1] as the thing to collect, so
      // this case's own argument is the next one along. Reading positional[1]
      // here crawls a term called "catalog", which finds nothing and reports
      // success, and there is no way to ask for a term other than the current
      // one because the fallback can never fire.
      const term = positional[2] ?? currentTerm();
      const result = await crawlTerm(term, {
        onProgress: (p) =>
          progress(`${blue(term)} ${p.phase}  page ${p.page}/${p.pages}  ${n(p.items)}`),
      });
      endProgress();
      say("term", term);
      say("sections", n(result.sections));
      say("courses", n(result.courses));
      return;
    }

    case "book": {
      const year = positional[2] ?? catalogYear();
      const book = await crawlBook(year, {
        onProgress: (p) =>
          progress(`${pink(year)}  page ${p.page}/${p.pages}  ${p.programs} programs`),
      });
      endProgress();
      replaceYear(year, book.programs, book.fetchedAt);
      forgetModel();
      say("year", year);
      say("pages", n(book.pages));
      say("programs", n(book.programs.length));
      return;
    }

    case "campus": {
      const result = await collectCampus();
      say("buildings", n(result.buildings));
      if (result.fromTour) say("from the tour", n(result.fromTour));
      if (result.pinned) say("pinned", n(result.pinned));
      if (result.missing.length) {
        say("unmapped", n(result.missing.length));
        console.error(dim(`  ${result.missing.join(", ")}`));
      }
      return;
    }

    case "rule": {
      const [, requirement, subrequirement, group] = positional;
      if (!requirement || !subrequirement || !group) {
        console.error("usage: engine collect rule <requirement> <subrequirement> <group>");
        process.exit(1);
      }
      const courses = await collectRule({ requirement, subrequirement, group });
      say("courses", n(courses.length));
      console.log(courses.join("\n"));
      return;
    }

    default:
      console.error("collect what? directory | catalog | book | campus | rule");
      process.exit(1);
  }
}

async function main(): Promise<void> {
  switch (positional[0]) {
    case "import": {
      const report = importAll({
        directory: flag("directory"),
        catalog: flag("catalog"),
        book: flag("book"),
        harvests: flag("harvests"),
        majors: flag("majors"),
        labels: flag("labels"),
      });
      if (report.directory) say("people", n(report.directory.people));
      if (report.catalog) {
        say("terms", report.catalog.terms.join(", "));
        say("sections", n(report.catalog.sections));
        say("courses", n(report.catalog.courses));
        say("rules", n(report.catalog.rules));
      }
      if (report.book) say("programs", `${n(report.book.programs)} (${report.book.year})`);
      if (report.majors) {
        say("majors", `${n(report.majors.programs)} in ${n(report.majors.schools)} schools`);
      }
      for (const labels of report.labels ?? []) {
        say(labels.source, `${n(labels.matched)} known majors, ${n(labels.unmatched)} unmatched`);
      }
      for (const term of report.harvests ?? []) {
        say(term.term, `${n(term.withBooks)} booklists of ${n(term.students)}`);
      }
      for (const missing of report.skipped) console.error(dim(`  skipped ${missing}`));
      return;
    }

    case "collect":
      return collect(positional[1]);

    case "harvester": {
      const term = positional[1] ?? currentTerm();
      const { script, ids } = buildHarvester({ term, studentClass: flag("class") });
      const out = flag("out", `cedar-harvester-${term}.user.js`)!;
      writeFileSync(out, script);
      say("term", term);
      say("ids", n(ids.length));
      say("wrote", `${out} (${(script.length / 1024).toFixed(1)}KB)`);
      console.error(
        dim("  install in Tampermonkey, open the store, press Start; then: engine ingest <file>"),
      );
      return;
    }

    case "ingest": {
      const file = positional[1];
      if (!file) {
        console.error("usage: engine ingest <harvest.json> [--term 2027SP]");
        process.exit(1);
      }
      const result = ingestFile(file, flag("term"));
      say("term", result.term);
      say("students", n(result.students));
      say("with books", n(result.withBooks));
      say("new", n(result.added));
      say("changed", n(result.changed));
      return;
    }

    case "labels": {
      const file = positional[1];
      if (!file) {
        console.error("usage: engine labels <file.csv>");
        process.exit(1);
      }
      const result = loadLabelsFile(file, flag("source"));
      say("source", result.source);
      say("matched", n(result.matched));
      if (result.unmatched.length) {
        say("unmatched", n(result.unmatched.length));
        for (const miss of result.unmatched) console.error(dim(`    ${miss.name}`));
      }
      return;
    }

    case "evaluate": {
      const result = evaluate({ source: flag("source"), year: flag("year") });
      const rate = (value: number) => `${Math.round(value * 100)}%`;
      say("labels", n(result.scored));
      say("no booklist", n(result.skipped));
      say("terms", result.terms || "none");
      say("exact", pink(rate(result.exact)));
      say("top 3", rate(result.top3));
      say("cluster", rate(result.cluster));
      if (has("misses")) {
        for (const miss of result.misses) {
          console.error(dim(`    ${miss.studentId}  ${miss.known}  ->  ${miss.guessed}`));
        }
      }
      return;
    }

    case "guess": {
      const top = Number(flag("top", "3"));
      if (has("all")) {
        const rows: unknown[][] = [
          [
            "id",
            "name",
            "class",
            "terms",
            "signal",
            ...Array.from({ length: top }, (_, i) => [`guess${i + 1}`, `pct${i + 1}`]).flat(),
          ],
        ];
        for (const student of guessAll(top, flag("year"))) {
          rows.push([
            student.studentId,
            student.name,
            student.studentClass,
            student.terms.join("+"),
            student.signal,
            ...student.guesses.flatMap((g) => [g.title, Math.round(g.score * 100)]),
          ]);
        }
        const out = flag("out");
        if (out) {
          writeFileSync(out, toCSV(rows));
          say("students", n(rows.length - 1));
          say("wrote", out);
        } else console.log(toCSV(rows));
        return;
      }

      const query = positional[1];
      if (!query) {
        console.error('usage: engine guess "First Last" | <id> | --all [--out guesses.csv]');
        process.exit(1);
      }
      let id = /^\d+$/.test(query) ? query : null;
      if (!id) {
        const parts = query.split(/\s+/);
        const hits = findByName(parts[0] ?? "", parts.at(-1) ?? "");
        if (hits.length !== 1) {
          console.error(
            hits.length ? `${hits.length} people match "${query}"` : `no match for "${query}"`,
          );
          process.exit(1);
        }
        id = hits[0]!.id;
      }
      const student = guessFor(id, top, flag("year"));
      if (!student) {
        console.error("no booklist data for them yet");
        process.exit(1);
      }
      say("who", `${student.name ?? id} ${dim(`(${student.studentClass ?? "?"})`)}`);
      say("terms", student.terms.join("+"));
      say("signal", `${student.signal} distinctive courses of ${student.courses.length}`);
      for (const guess of student.guesses) {
        const school = guess.school ? dim(`  ${guess.school}`) : "";
        say(
          "",
          `${pink(`${Math.round(guess.score * 100)}%`.padStart(4))}  ${guess.title}${school}`,
        );
      }
      return;
    }

    case "stats": {
      const people = peopleStats();
      say("people", n(people.people));
      say("students", n(people.students));
      say("departed", n(people.gone));
      say("with a dorm", n(people.withDorm));
      say("buildings", n(buildings().length));
      say("catalog year", latestYear() ?? "none");
      say("programs", n(programYears()[0]?.programs ?? 0));
      for (const term of termStats()) {
        say(term.term, `${n(term.sections)} sections, ${n(term.courses)} courses`);
      }
      for (const term of harvestTerms()) say(term.term, `${n(term.students)} booklists`);
      console.error("");
      for (const sweep of recentSweeps(5)) {
        console.error(
          dim(
            `  ${sweep.startedAt.slice(0, 16).replace("T", " ")}  ${sweep.kind.padEnd(10)} ` +
              `${sweep.source.padEnd(9)} ${n(sweep.seen)} seen, ${n(sweep.added)} new`,
          ),
        );
      }
      return;
    }

    default:
      console.error(
        [
          "cedarengine",
          "",
          "  import                      seed from the older projects",
          "  collect directory           sweep the directory (needs a session)",
          "  collect catalog [term]      crawl a term, or --all for every course",
          "  collect book [year]         read the printed catalog",
          "  collect campus              fetch the map",
          "  collect rule <r> <s> <g>    resolve one requirement group",
          "  harvester [term]            write the booklist userscript",
          "  ingest <file>               file a harvest",
          "  labels <file.csv>           load known majors",
          "  evaluate                    score the model",
          '  guess "First Last" | --all  guess a major',
          "  stats                       what the engine holds",
        ].join("\n"),
      );
      process.exit(1);
  }
}

await main();
