import { parseArcticPost, redditSource } from './reddit';
import type { Env } from './ingest';

/** Bounded Arctic image repair.
 *
 * The scheduled scan parses Arctic Shift's newest-100 r/PuertoRico window. A post whose
 * only observation was parsed before the current image extraction was deployed (or
 * during the current HTTP-429 streak on Arctic Shift) can age out of that window with an
 * empty image and is then never reparsed, so a real photo stays missing for the post's
 * whole 14-day life.
 *
 * This pass repairs those rows with Arctic Shift's documented ID lookup
 * (GET /api/posts/ids, ids limit 500): at most POSTS_PER_RUN post IDs in ONE request,
 * at most once per hour, three attempts per post. A post present in the lookup that
 * still yields no image is a genuine text post or a Reddit placeholder and is
 * terminated — no retries, no loops. The same per-post validation as the feed scan is
 * reused verbatim, and the recovered URL is stored and archived exactly like a
 * feed-provided image through the existing triggers. No login, no scraping fallback,
 * and no AI.
 */

const ARCTIC_IDS = 'https://arctic-shift.photon-reddit.com/api/posts/ids';
const POSTS_PER_RUN = 12;
const MAX_ATTEMPTS = 3;
const ATTEMPT_WAIT = 3600000;
const ID_QUERY = `SELECT a.url, a.payload FROM articles a
 WHERE a.source=? AND a.published_at>=? AND COALESCE(json_extract(a.payload,'$.image'),'')=''
 AND NOT EXISTS (SELECT 1 FROM arctic_image_repair q WHERE q.url=a.url AND q.attempts>=?)
 ORDER BY a.published_at DESC LIMIT ?`;
/** First insert books attempt 1; a conflict raises the attempt until the cap. */
const RETRY_LEDGER = `INSERT INTO arctic_image_repair(url,attempts,next_attempt,error) VALUES(?,1,?,?)
 ON CONFLICT(url) DO UPDATE SET attempts=arctic_image_repair.attempts+1,next_attempt=excluded.next_attempt,error=excluded.error
 WHERE arctic_image_repair.attempts<?`;

export async function repairArcticImages(env: Env, now: number) {
 const owner = crypto.randomUUID();
 // The 60-minute lease is also the cadence cap: refresh runs every 15 minutes and
 // skips this pass while the lease lives, so Arctic Shift sees at most one repair
 // request per hour — the same at-most-hourly bound the feed scan honors. The lease
 // is deliberately not released afterwards; the next pass replaces it.
 const lock = await env.DB.prepare(`INSERT INTO jobs(id,lease_until,owner) VALUES('arctic-image-repair',?,?) ON CONFLICT(id) DO UPDATE SET lease_until=excluded.lease_until,owner=excluded.owner WHERE jobs.lease_until<?`).bind(now + 60 * 60000, owner, now).run();
 if (!lock.meta.changes) return {skipped: 'already running'};
 // Newest first, so the posts readers actually see on the pages repair first. Only
 // in-window rows with an empty image and no attempt-capped ledger row qualify.
 const {results: rows} = await env.DB.prepare(ID_QUERY)
  .bind(redditSource, now - 14 * 86400000, MAX_ATTEMPTS, POSTS_PER_RUN).all<{url: string; payload: string}>();
 if (!rows.length) return {requested: 0, repaired: 0, terminal: 0};
 const postId = (url: string) => url.split('/comments/')[1]?.split('/')[0] ?? '';
 const idsParam = rows.map(r => postId(r.url)).join(',');
 let data: any[];
 try {
  const response = await fetch(`${ARCTIC_IDS}?ids=${encodeURIComponent(idsParam)}`, {headers: {'User-Agent': 'news.dev.pr/1.0 (+https://news.dev.pr/about)'}, signal: AbortSignal.timeout(15000)});
  if (!response.ok) {await response.body?.cancel(); throw new Error(`HTTP ${response.status}`);}
  const payload = JSON.parse(await response.text());
  if (!Array.isArray(payload.data)) throw new Error('Invalid Arctic Shift response');
  data = payload.data;
 } catch (error) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  for (const row of rows) await env.DB.prepare(RETRY_LEDGER).bind(row.url, now + ATTEMPT_WAIT, message, MAX_ATTEMPTS).run();
  return {requested: rows.length, error: message};
 }
 const byId = new Map<string, any>(data.map((post: any) => [String(post?.id ?? ''), post]));
 let repaired = 0, terminal = 0;
 for (const row of rows) {
  const post = byId.get(postId(row.url));
  if (!post) { // The archive lookup missed it: bounded retry, then stop.
   await env.DB.prepare(RETRY_LEDGER).bind(row.url, now + ATTEMPT_WAIT, 'Post not in the Arctic lookup', MAX_ATTEMPTS).run();
   continue;
  }
  const item = parseArcticPost(post, now);
  if (!item?.image) { // In the archive, still no photo (text post or placeholder): terminal.
   await env.DB.prepare(`INSERT INTO arctic_image_repair(url,attempts,next_attempt,error) VALUES(?,?,0,?) ON CONFLICT(url) DO UPDATE SET attempts=excluded.attempts,next_attempt=0,error=excluded.error WHERE arctic_image_repair.attempts<?`).bind(row.url, MAX_ATTEMPTS, 'No photo in the Arctic record', MAX_ATTEMPTS).run();
   terminal++;
   continue;
  }
  // Image-only payload update: title and summary must still match, so the stored
  // translation and any concurrent reclassification survive. The existing payload
  // triggers move the new URL through archive_revisions into the R2 image queue.
  const merged = await env.DB.prepare(
   `UPDATE articles SET payload=json_set(payload,'$.image',?),updated_at=?
    WHERE url=? AND COALESCE(json_extract(payload,'$.image'),'')=''
    AND json_extract(payload,'$.title')=json_extract(?,'$.title')
    AND json_extract(payload,'$.summary')=json_extract(?,'$.summary')`)
   .bind(item.image, now, row.url, row.payload, row.payload).run();
  if (merged.meta.changes) repaired++;
  // Bookkeeping only, so a row whose image arrived from the hourly scan meanwhile
  // simply stops occupying queue slots.
  await env.DB.prepare('INSERT INTO arctic_image_repair(url,attempts,next_attempt,error) VALUES(?,1,0,NULL) ON CONFLICT(url) DO NOTHING').bind(row.url).run();
 }
 return {requested: rows.length, repaired, terminal};
}
