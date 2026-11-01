/** The final exam tables, one per term the registrar has published. */

import type { ExamSchedule } from "../collect/exams";
import { db } from "../db";

export function saveExamSchedule(schedule: ExamSchedule): void {
  db()
    .query(
      `INSERT INTO exams (term, source, payload, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(term) DO UPDATE SET
         source = excluded.source, payload = excluded.payload, fetched_at = excluded.fetched_at`,
    )
    .run(schedule.term, schedule.source, JSON.stringify(schedule), schedule.fetchedAt);
}

export function examSchedule(term: string): ExamSchedule | null {
  const row = db()
    .query<{ payload: string }, [string]>("SELECT payload FROM exams WHERE term = ?")
    .get(term);
  return row ? (JSON.parse(row.payload) as ExamSchedule) : null;
}

export const examTerms = (): string[] =>
  db()
    .query<{ term: string }, []>("SELECT term FROM exams ORDER BY term")
    .all()
    .map((r) => r.term);
