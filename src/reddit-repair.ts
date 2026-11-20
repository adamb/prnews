import { arcticFeed, parseArcticPost, redditSource } from './reddit';
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
 *
 * Backoff coordination: the pass never adds requests against a host that just said
 * to slow down. While the feed scan itself is in failure backoff (a 429 with
 * Retry-After included), the repair writes nothing and sends nothing, so its three
 * attempts cannot burn out before the host recovers. Its own 429/503 answers honor
 * Retry-After the same way the scan does, and a row's next_attempt is read before
 * the row can be requested again.
 */

const ARCTIC_IDS = 'https://arctic-shift.photon-reddit.com/api/posts/ids';
const POSTS_PER_RUN = 12;
const MAX_ATTEMPTS = 3;
const ATTEMPT_WAIT = 3600000;
const ID_QUERY = `SELECT a.url, a.payload FROM articles a
 WHERE a.source=? AND a.published_at>=? AND COALESCE(json_extract(a.payload,'$.image'),'')=''
 AND NOT EXISTS (SELECT 1 FROM arctic_image_repair q WHERE q.url=a.url AND (q.attempts>=? OR q.next_attempt>?))
 ORDER BY a.published_at DESC LIMIT ?`;
/** First insert books attempt 1; a conflict raises the attempt until the cap. */
const RETRY_LEDGER = `INSERT INTO arctic_image_repair(url,attempts,next_attempt,error) VALUES(?,1,?,?)
 ON CONFLICT(url) DO UPDATE SET attempts=arctic_image_repair.attempts+1,next_attempt=excluded.next_attempt,error=excluded.error
 WHERE arctic_image_repair.attempts<?`;
/** Marks a row as done at the cap so it is never selected again. */
const TERMINAL_LEDGER = `INSERT INTO arctic_image_repair(url,attempts,next_attempt,error) VALUES(?,?,0,?)
 ON CONFLICT(url) DO UPDATE SET attempts=excluded.attempts,next_attempt=0,error=excluded.error
 WHERE arctic_image_repair.attempts<?`;
/** Same Retry-After parsing as the feed scan: seconds or HTTP-date, 0 when absent. */
function retryAfter(response: Response, now: number): number {
 const value = response.headers.get('Retry-After');
 if (!value) return 0;
 const seconds = Number(value);
 const at = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(value);
 return Number.isFinite(at) ? at : 0;
}

export async function repairArcticImages(env: Env, now: number) {
 // Global cadence, shared with the hourly scan: while the scan's own state says the
 // host asked us to wait (failure backoff, Retry-After included), the repair stays
 // completely quiet — no request, no lease, no attempt booked — so it never compounds
 // the very rate limit the scan is already backing off from. The check is read-only;
 // a healthy scan's ordinary hourly next_check (failures=0) never blocks the repair.
 const scan = await env.DB.prepare('SELECT failures,next_check FROM feed_state WHERE url=?').bind(arcticFeed).first<{failures: number; next_check: number}>();
 if (scan && scan.failures > 0 && scan.next_check > now) return {skipped: 'arctic backoff'};
 const owner = crypto.randomUUID();
 // The 60-minute lease is also the cadence cap: refresh runs every 15 minutes and
 // skips this pass while the lease lives, so Arctic Shift sees at most one repair
 // request per hour — the same at-most-hourly bound the feed scan honors. The lease
 // is deliberately not released afterwards; the next pass replaces it.
 const lock = await env.DB.prepare(`INSERT INTO jobs(id,lease_until,owner) VALUES('arctic-image-repair',?,?) ON CONFLICT(id) DO UPDATE SET lease_until=excluded.lease_until,owner=excluded.owner WHERE jobs.lease_until<?`).bind(now + 60 * 60000, owner, now).run();
 if (!lock.meta.changes) return {skipped: 'already running'};
 // Newest first, so the posts readers actually see on the pages repair first. Only
 // in-window rows with an empty image, no attempt-capped ledger row, and whose
 // booked next_attempt has elapsed qualify.
 const {results: selected} = await env.DB.prepare(ID_QUERY)
  .bind(redditSource, now - 14 * 86400000, MAX_ATTEMPTS, now, POSTS_PER_RUN).all<{url: string; payload: string}>();
 const postId = (url: string) => url.split('/comments/')[1]?.split('/')[0] ?? '';
 // A row without a parseable comments ID can never be looked up; end it honestly
 // instead of requesting or reselecting it forever.
 let terminal = 0;
 const rows: typeof selected = [];
 for (const row of selected) {
  if (postId(row.url)) { rows.push(row); continue; }
  await env.DB.prepare(TERMINAL_LEDGER).bind(row.url, MAX_ATTEMPTS, 'Not a Reddit comments URL', MAX_ATTEMPTS).run();
  terminal++;
 }
 if (!rows.length) return {requested: 0, repaired: 0, terminal};
 const idsParam = rows.map(r => postId(r.url)).join(',');
 let data: any[];
 try {
  const response = await fetch(`${ARCTIC_IDS}?ids=${encodeURIComponent(idsParam)}`, {headers: {'User-Agent': 'news.dev.pr/1.0 (+https://news.dev.pr/about)'}, signal: AbortSignal.timeout(15000)});
  if (!response.ok) {
   // Honor the host's Retry-After the same way the scan does; otherwise wait an hour.
   const wait = Math.max(now + ATTEMPT_WAIT, retryAfter(response, now));
   const status = response.status;
   await response.body?.cancel();
   throw Object.assign(new Error(`HTTP ${status}`), {wait});
  }
  const payload = JSON.parse(await response.text());
  if (!Array.isArray(payload.data)) throw new Error('Invalid Arctic Shift response');
  data = payload.data;
 } catch (error) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  const wait = error instanceof Error && typeof (error as any).wait === 'number' ? (error as any).wait : now + ATTEMPT_WAIT;
  for (const row of rows) await env.DB.prepare(RETRY_LEDGER).bind(row.url, wait, message, MAX_ATTEMPTS).run();
  return {requested: rows.length, error: message};
 }
 const byId = new Map<string, any>(data.map((post: any) => [String(post?.id ?? ''), post]));
 let repaired = 0;
 for (const row of rows) {
  const post = byId.get(postId(row.url));
  if (!post) { // The archive lookup missed it: bounded retry, then stop.
   await env.DB.prepare(RETRY_LEDGER).bind(row.url, now + ATTEMPT_WAIT, 'Post not in the Arctic lookup', MAX_ATTEMPTS).run();
   continue;
  }
  const item = parseArcticPost(post, now);
  if (!item?.image) { // In the archive, still no photo (text post or placeholder): terminal.
   await env.DB.prepare(TERMINAL_LEDGER).bind(row.url, MAX_ATTEMPTS, 'No photo in the Arctic record', MAX_ATTEMPTS).run();
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
