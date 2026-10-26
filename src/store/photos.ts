/**
 * Directory photos, kept as bytes.
 *
 * Faculty photos are public URLs the app loads straight from cedarville.edu.
 * A student's is a relative link into the campus portal behind a login, so the
 * browser extension fetches it signed in and posts the bytes here, and the
 * engine serves them to anyone holding the token. The hash is the ETag and the
 * way a re-sweep skips a photo that has not changed.
 */

import { db } from "../db";

export interface StoredPhoto {
  contentType: string;
  bytes: Uint8Array;
  hash: string;
}

const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/**
 * Store one photo, reporting whether the bytes were new or already held.
 *
 * An unchanged photo still touches `fetched_at`: it records that the photo was
 * checked and is current, so the staleness sweep does not keep re-fetching it,
 * without rewriting the bytes.
 */
export function putPhoto(
  id: string,
  contentType: string,
  bytes: Uint8Array,
): "stored" | "unchanged" {
  const hash = sha256(bytes);
  const now = new Date().toISOString();
  const existing = db()
    .query<{ hash: string }, [string]>("SELECT hash FROM photos WHERE student_id = ?")
    .get(id);
  if (existing?.hash === hash) {
    db().query("UPDATE photos SET fetched_at = ? WHERE student_id = ?").run(now, id);
    return "unchanged";
  }
  db()
    .query(
      `INSERT INTO photos (student_id, content_type, bytes, hash, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(student_id) DO UPDATE SET
         content_type = excluded.content_type, bytes = excluded.bytes,
         hash = excluded.hash, fetched_at = excluded.fetched_at`,
    )
    .run(id, contentType, bytes, hash, now);
  return "stored";
}

/**
 * Record that a person has no photo on file.
 *
 * The directory lists a photo link for people the portal then 404s. Without a
 * row they stay "missing" and the sweep re-fetches them first every time,
 * blocking everyone behind them. An empty row marks them checked, so they drop
 * out until the staleness window brings them back around.
 */
export function markNoPhoto(id: string): void {
  db()
    .query(
      `INSERT INTO photos (student_id, content_type, bytes, hash, fetched_at)
       VALUES (?, '', ?, '', ?)
       ON CONFLICT(student_id) DO UPDATE SET
         content_type = '', bytes = excluded.bytes, hash = '', fetched_at = excluded.fetched_at`,
    )
    .run(id, new Uint8Array(0), new Date().toISOString());
}

export function getPhoto(id: string): StoredPhoto | null {
  const row = db()
    .query<{ content_type: string; bytes: Uint8Array; hash: string }, [string]>(
      "SELECT content_type, bytes, hash FROM photos WHERE student_id = ?",
    )
    .get(id);
  if (!row || row.bytes.length === 0) return null;
  return { contentType: row.content_type, bytes: row.bytes, hash: row.hash };
}

export const photoCount = (): number =>
  db().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM photos WHERE length(bytes) > 0").get()
    ?.n ?? 0;
