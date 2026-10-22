/**
 * The ingest surface, written for a browser extension.
 *
 * Three of the sources are behind a login the server cannot hold: the
 * directory and the course search need an SSO session, and the campus store
 * needs a WAF challenge solved by a real browser. A browser you are already
 * signed into has all of them, which makes the extension the natural collector
 * and this the natural shape for it — courier, not crawler.
 *
 * So the protocol is deliberately dumb on the client side. Ask what to do, do
 * it, post what came back, repeat until told to stop. Every decision about
 * coverage, splitting and completeness stays here.
 */

import { fileCrawl } from "../collect/catalog";
import { planBooklists, planCatalog, planDirectory } from "../collect/plan";
import { db } from "../db";
import { badRequest, body, json, q } from "../lib/http";
import { currentTerm } from "../lib/terms";
import { ALL_COURSES } from "../store/catalog";
import { ingestHarvest } from "../store/harvest";
import { bumpSweep, finishSweep, lastSweep, startSweep } from "../store/history";
import { retireUnseen, upsertPeople } from "../store/people";
import type { RouteDef } from "./types";

interface StartBody {
  kind?: "directory" | "booklists" | "catalog";
  /** Sweep the whole name space again. Required before anyone can be retired. */
  refresh?: boolean;
  term?: string;
  limit?: number;
  /** Catalog only: the term codes Self-Service lists right now. */
  listed?: string[];
}

interface CatalogBody {
  sweep?: number;
  term?: string;
  sections?: any[];
  courses?: any[];
  /** The last post of a sweep, carrying the terms that could not be fetched. */
  done?: boolean;
  failed?: string[];
}

interface DirectoryBody {
  sweep?: number;
  results?: { last: string; first: string; people: Record<string, unknown>[] }[];
  limit?: number;
}

interface BooklistBody {
  sweep?: number;
  term?: string;
  rows?: { id: string | number; books?: any[] }[];
}

const sweepStartedAt = (id: number): string | null =>
  db().query<{ started_at: string }, [number]>("SELECT started_at FROM sweeps WHERE id = ?").get(id)
    ?.started_at ?? null;

export const syncRoutes: RouteDef[] = [
  {
    method: "GET",
    path: "/v1/sync/manifest",
    tag: "sync",
    summary: "What the extension should collect, and how stale each source is",
    query: [{ name: "term", description: "Term to harvest booklists for" }],
    handler: (_request, url) => {
      const term = q(url, "term") ?? currentTerm();
      const plan = planDirectory(0);
      return json({
        term,
        directory: {
          lastSweep: lastSweep("directory"),
          ...plan,
          settled: plan.pending === 0,
        },
        booklists: { ...planBooklists(term, 0), lastSweep: lastSweep("booklists") },
        catalog: { lastSweep: lastSweep("catalog") },
      });
    },
  },
  {
    method: "POST",
    path: "/v1/sync/start",
    tag: "sync",
    summary: "Open a sweep and get the first batch of work",
    body: '{ "kind": "directory" | "booklists" | "catalog", "refresh": false, "term": "2027SP", "limit": 100, "listed": ["2026FA"] }',
    handler: async (request) => {
      const options = await body<StartBody>(request);
      const kind = options.kind ?? "directory";

      if (kind === "catalog") {
        const listed = options.listed ?? [];
        if (!Array.isArray(listed)) throw badRequest("listed must be an array of term codes");
        const plan = planCatalog(listed.map(String));
        const sweep = startSweep("catalog", "extension", plan.terms.join(" "));
        return json({ sweep, kind, ...plan });
      }

      if (kind === "booklists") {
        const term = options.term ?? currentTerm();
        const sweep = startSweep("booklists", "extension", term);
        return json({ sweep, kind, ...planBooklists(term, options.limit ?? 500) });
      }

      // A fresh generation is the only thing that can prove somebody left, so
      // refreshing clears the record of which queries have been asked.
      if (options.refresh) db().exec("DELETE FROM sweep_queries");
      const sweep = startSweep("directory", "extension", options.refresh ? "refresh" : undefined);
      return json({ sweep, kind, ...planDirectory(options.limit ?? 100) });
    },
  },
  {
    method: "POST",
    path: "/v1/sync/directory",
    tag: "sync",
    summary: "Post directory results and get the next batch",
    body: '{ "sweep": 12, "results": [{ "last": "kl", "first": "", "people": [...] }] }',
    handler: async (request) => {
      const payload = await body<DirectoryBody>(request);
      const results = payload.results ?? [];

      const database = db();
      const noteQuery = database.query(
        "INSERT OR REPLACE INTO sweep_queries (last, first, count, at) VALUES (?, ?, ?, ?)",
      );

      let added = 0;
      let changed = 0;
      let seen = 0;
      for (const result of results) {
        const at = new Date().toISOString();
        const tally = upsertPeople(result.people ?? [], at);
        noteQuery.run(result.last ?? "", result.first ?? "", (result.people ?? []).length, at);
        added += tally.added;
        changed += tally.changed;
        seen += tally.seen;
      }

      if (payload.sweep) bumpSweep(payload.sweep, { seen, added, changed });

      const plan = planDirectory(payload.limit ?? 100);
      const settled = plan.pending === 0;
      let vanished = 0;

      // The sweep is only finished when nothing is left to ask, and only a
      // generation that started from scratch may retire the people it missed.
      if (settled && payload.sweep) {
        const startedAt = sweepStartedAt(payload.sweep);
        const refreshed =
          db()
            .query<{ note: string | null }, [number]>("SELECT note FROM sweeps WHERE id = ?")
            .get(payload.sweep)?.note === "refresh";
        if (startedAt && refreshed) vanished = retireUnseen(startedAt);
        finishSweep(payload.sweep, {
          vanished,
          complete: refreshed && plan.stuck === 0,
        });
      }

      return json({ ...plan, accepted: results.length, added, changed, vanished, done: settled });
    },
  },
  {
    method: "POST",
    path: "/v1/sync/booklists",
    tag: "sync",
    summary: "Post harvested booklists and get the next batch of ids",
    body: '{ "sweep": 13, "term": "2027SP", "rows": [{ "id": "1234567", "books": [...] }] }',
    handler: async (request) => {
      const payload = await body<BooklistBody>(request);
      const term = payload.term ?? currentTerm();
      const rows = payload.rows ?? [];
      if (!Array.isArray(rows)) throw badRequest("rows must be an array of { id, books }");

      const tally = ingestHarvest(term, rows);
      if (payload.sweep) {
        bumpSweep(payload.sweep, {
          seen: tally.students,
          added: tally.added,
          changed: tally.changed,
        });
      }

      const plan = planBooklists(term, 500);
      if (payload.sweep && plan.remaining === 0) {
        finishSweep(payload.sweep, { complete: true, note: term });
      }
      return json({ ...plan, ...tally, term, done: plan.remaining === 0 });
    },
  },
  {
    method: "POST",
    path: "/v1/sync/catalog",
    tag: "sync",
    summary: "Post one term of the course search, or close the catalog sweep",
    body: '{ "sweep": 14, "term": "2027SP", "sections": [...], "courses": [...] } | { "sweep": 14, "done": true, "failed": [] }',
    handler: async (request) => {
      const payload = await body<CatalogBody>(request);

      if (payload.done) {
        const failed = Array.isArray(payload.failed) ? payload.failed.map(String) : [];
        if (payload.sweep) {
          finishSweep(payload.sweep, {
            complete: failed.length === 0,
            note: failed.length ? `failed: ${failed.join(" ")}` : undefined,
          });
        }
        return json({ done: true, failed });
      }

      if (!payload.term) throw badRequest("term is required");
      const sections = payload.sections ?? [];
      const courses = payload.courses ?? [];
      if (!Array.isArray(sections) || !Array.isArray(courses)) {
        throw badRequest("sections and courses must be arrays");
      }

      const filed = fileCrawl(payload.term, sections, courses);
      if (payload.sweep) bumpSweep(payload.sweep, { seen: filed.sections + filed.courses });
      // Nothing filed means the previous catalog was kept on purpose, and the
      // courier should count the term as failed.
      const kept = payload.term === ALL_COURSES ? filed.courses === 0 : filed.sections === 0;
      return json({ term: payload.term, ...filed, kept });
    },
  },
];
