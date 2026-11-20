import type {Env} from './ingest';
import {currentItem} from './current-item';
import type {Item} from './parse';
import {VERSION, key, valid} from './lighter';

/** Anonymous 👍/👎 on a displayed satire take.
 * A vote is accepted only for the exact cached generation the page can show right
 * now: the stored article's current headline/excerpt/language, resolved to the same
 * lighter-2 cache key generation uses, with a stored text that still passes valid().
 * A future headline or excerpt produces a different key, so it inherits no ratings.
 * One current vote per browser per take: the browser keeps a random UUID in
 * localStorage; the server stores only its SHA-256 hash and (token_hash, cache_key)
 * is the primary key, so repeats are idempotent and changes move one row.
 * No email, IP, cookie, account, or fingerprint is read or stored. Votes never call
 * the model and never touch the generation budget or its removed global limits;
 * the guards below protect the counts only. GET never reaches a write. */

/** A take needs at least this many votes before /stats lists it as an example,
 * so one vote can never present a take as the best or worst. */
export const FEEDBACK_MIN_SAMPLE = 3;
/** Vote writes per UTC minute, across everyone (not per person, no address stored). */
export const FEEDBACK_RATE_PER_MINUTE = 60;
/** Overlapping vote writes stay bounded to two short leases. */
export const FEEDBACK_MAX_CONCURRENT = 2;
const VOTE_LEASE_MS = 10_000;
const BODY_LIMIT = 1000;
const TOKEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FeedbackEdition = 'es' | 'en';
export type FeedbackVote = 'up' | 'down' | 'none';
export interface FeedbackExample { lang: FeedbackEdition; title: string; text: string; url: string; storyId: number | null; ups: number; downs: number }
export interface FeedbackView { available: true; up: number; down: number; ratedTakes: number; minSample: number; top: FeedbackExample[]; bottom: FeedbackExample[] }

const changed = (result: {meta?: {changes?: number}}) => Number(result?.meta?.changes ?? 0) > 0;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});

function sameOrigin(request: Request, url: URL) {
  if (request.headers.get('X-PRNews-Action') !== 'lighter-vote') return false;
  // Fail closed: a missing Origin is not same-origin. Browsers send it on this POST.
  if (request.headers.get('Origin') !== url.origin) return false;
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') return false;
  const type = (request.headers.get('Content-Type') ?? '').toLowerCase();
  return type.startsWith('application/json');
}

/** Domain-separated SHA-256, so the stored hash cannot be reused as any other feature's id. */
async function tokenHash(token: string): Promise<string> {
  const bytes = new TextEncoder().encode('prnews-lighter-vote:' + token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function loadStored(env: Env, articleUrl: string): Promise<Item | null> {
  const row = await env.DB.prepare('SELECT payload FROM articles WHERE url=?').bind(articleUrl).first<{payload: string}>();
  if (!row?.payload) return null;
  try { return currentItem(JSON.parse(row.payload) as Item); } catch { return null; }
}

/** The take a vote may attach to: the current generation's cache cell, with a valid text. */
async function votableTake(env: Env, item: Item, lang: FeedbackEdition) {
  const cacheKey = key(item, lang);
  try {
    const row = await env.DB.prepare('SELECT text FROM lighter_cache WHERE key=?').bind(cacheKey).first<{text: string | null}>();
    const take = typeof row?.text === 'string' ? row.text.trim() : '';
    return {cacheKey, take: take && valid(take, item, lang) ? take : ''};
  } catch { return {cacheKey, take: ''}; }
}

async function allowVoteRate(env: Env, now: number) {
  const bucket = Math.floor(now / 60000);
  await env.DB.prepare('DELETE FROM lighter_vote_rate WHERE bucket<?').bind(bucket - 2).run();
  const result = await env.DB.prepare('INSERT INTO lighter_vote_rate(bucket, hits) VALUES(?,1) ON CONFLICT(bucket) DO UPDATE SET hits=hits+1 WHERE hits<?').bind(bucket, FEEDBACK_RATE_PER_MINUTE).run();
  return changed(result);
}

async function claimVoteSlot(env: Env, now: number) {
  const until = now + VOTE_LEASE_MS;
  for (let id = 1; id <= FEEDBACK_MAX_CONCURRENT; id++) {
    const result = await env.DB.prepare('UPDATE lighter_vote_inflight SET until_ms=? WHERE id=? AND until_ms<=?').bind(until, id, now).run();
    if (changed(result)) return {id, until};
  }
  return null;
}

async function releaseVoteSlot(env: Env, slot: {id: number; until: number} | null) {
  if (slot) await env.DB.prepare('UPDATE lighter_vote_inflight SET until_ms=0 WHERE id=? AND until_ms=?').bind(slot.id, slot.until).run().catch(() => {});
}

/** Public vote submission. GET, HEAD, and page renders never reach a write; no AI anywhere. */
export async function lighterFeedbackRoute(request: Request, env: Env, now = Date.now()): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/lighter-vote') return undefined;
  if (request.method !== 'POST') return json({status: 'method'}, 405);
  if (!sameOrigin(request, url)) return json({status: 'forbidden'}, 403);
  if (!env.DB) return json({status: 'unavailable'}, 503);
  let raw = '';
  try { raw = await request.text(); } catch { return json({status: 'bad_request'}, 400); }
  if (raw.length > BODY_LIMIT) return json({status: 'bad_request'}, 400);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({status: 'bad_request'}, 400); }
  const record = body && typeof body === 'object' ? body as {url?: unknown; lang?: unknown; vote?: unknown; token?: unknown} : {};
  const articleUrl = typeof record.url === 'string' && record.url.length >= 8 && record.url.length <= 2000 && /^https:\/\//.test(record.url) && !/[\u0000-\u001f\s]/.test(record.url) ? record.url : '';
  const lang: FeedbackEdition | '' = record.lang === 'es' || record.lang === 'en' ? record.lang : '';
  const vote: FeedbackVote | '' = record.vote === 'up' || record.vote === 'down' || record.vote === 'none' ? record.vote : '';
  const token = typeof record.token === 'string' && record.token.length <= 100 && TOKEN_ID.test(record.token) ? record.token.toLowerCase() : '';
  if (!articleUrl || !lang || !vote || !token) return json({status: 'bad_request'}, 400);
  try {
    const item = await loadStored(env, articleUrl);
    if (!item) return json({status: 'unknown'}, 404);
    const take = await votableTake(env, item, lang);
    // Not the displayed take: superseded, hidden, or never generated. Never a write.
    if (!take.take) return json({status: 'gone'}, 409);
    if (!(await allowVoteRate(env, now))) return json({status: 'rate'}, 429);
    const slot = await claimVoteSlot(env, now);
    if (!slot) return json({status: 'busy'}, 429);
    try {
      const hash = await tokenHash(token);
      if (vote === 'none') {
        await env.DB.prepare('DELETE FROM lighter_votes WHERE token_hash=? AND cache_key=?').bind(hash, take.cacheKey).run();
      } else {
        await env.DB.prepare('INSERT INTO lighter_votes(token_hash,cache_key,vote,voted_at) VALUES(?,?,?,?) ON CONFLICT(token_hash,cache_key) DO UPDATE SET vote=excluded.vote, voted_at=excluded.voted_at').bind(hash, take.cacheKey, vote, now).run();
      }
      console.info('lighter_vote', {lang, vote});
      return json({status: 'ok', vote});
    } finally { await releaseVoteSlot(env, slot); }
  } catch {
    return json({status: 'unavailable'}, 503);
  }
}

/** Cache-key JSON is [VERSION, url, title, summary, lang]; reconstruct a minimal item. */
function takeFromKey(cacheKey: string): {lang: FeedbackEdition; url: string; title: string; summary: string} | null {
  try {
    const parts = JSON.parse(cacheKey) as unknown[];
    if (!Array.isArray(parts) || parts.length !== 5 || parts[0] !== VERSION) return null;
    const [url, title, summary, lang] = parts.slice(1) as [string, string, string, string];
    if (typeof url !== 'string' || typeof title !== 'string' || typeof summary !== 'string') return null;
    if (lang !== 'es' && lang !== 'en') return null;
    return {lang, url, title, summary};
  } catch { return null; }
}

async function takeTexts(env: Env, cacheKeys: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const unique = [...new Set(cacheKeys)];
  for (let index = 0; index < unique.length; index += 40) {
    const chunk = unique.slice(index, index + 40);
    const rows = await env.DB.prepare(`SELECT key, text FROM lighter_cache WHERE key IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{key: string; text: string | null}>();
    for (const row of rows.results) if (typeof row.text === 'string' && row.text.trim()) found.set(row.key, row.text.trim());
  }
  return found;
}

type AggregateRow = {cache_key: string; ups: number; downs: number};

async function exampleRows(env: Env, order: 'top' | 'bottom'): Promise<AggregateRow[]> {
  // Best and worst stay separate: a take only leads its list when its net score
  // has that sign, so a down-voted take never appears under "most up-voted".
  const sign = order === 'top' ? '>0' : '<0';
  const rows = await env.DB.prepare(
    `SELECT cache_key, SUM(CASE WHEN vote='up' THEN 1 ELSE 0 END) AS ups, SUM(CASE WHEN vote='down' THEN 1 ELSE 0 END) AS downs
     FROM lighter_votes GROUP BY cache_key HAVING COUNT(*)>=? AND SUM(CASE WHEN vote='up' THEN 1 ELSE -1 END)${sign}
     ORDER BY SUM(CASE WHEN vote='up' THEN 1 ELSE -1 END) ${order === 'top' ? 'DESC' : 'ASC'}, COUNT(*) DESC, cache_key LIMIT 3`
  ).bind(FEEDBACK_MIN_SAMPLE).all<AggregateRow>();
  return rows.results;
}

async function examples(env: Env, rows: AggregateRow[], skipKeys: Set<string>): Promise<FeedbackExample[]> {
  const texts = await takeTexts(env, rows.map(row => row.cache_key));
  const out: FeedbackExample[] = [];
  for (const row of rows) {
    if (skipKeys.has(row.cache_key)) continue;
    const take = takeFromKey(row.cache_key);
    const text = texts.get(row.cache_key);
    if (!take || !text) continue;
    const item = {url: take.url, source: '', title: take.title, summary: take.summary, image: '', time: 0, observed: false, section: 'otras', reason: 'feedback'} as Item;
    // A take the current guard hides is not shown as an example, but its votes stay counted.
    if (!valid(text, item, take.lang)) continue;
    out.push({lang: take.lang, title: take.title, text, url: take.url, storyId: null, ups: Number(row.ups) || 0, downs: Number(row.downs) || 0});
    skipKeys.add(row.cache_key);
  }
  return out;
}

/** Aggregate read for /stats. A missing table or failed read is unavailable, never zero. */
export async function readLighterFeedback(env: Env): Promise<FeedbackView | {available: false}> {
  try {
    await env.DB.prepare('SELECT token_hash FROM lighter_votes LIMIT 1').first();
    const totals = await env.DB.prepare("SELECT vote, COUNT(*) AS n FROM lighter_votes GROUP BY vote").all<{vote: string; n: number}>();
    let up = 0, down = 0;
    for (const row of totals.results) { if (row.vote === 'up') up += Number(row.n) || 0; else if (row.vote === 'down') down += Number(row.n) || 0; }
    const rated = await env.DB.prepare('SELECT COUNT(DISTINCT cache_key) AS n FROM lighter_votes').first<{n: number}>();
    const topRows = await exampleRows(env, 'top');
    const top = await examples(env, topRows, new Set());
    const bottomRows = await exampleRows(env, 'bottom');
    const bottom = await examples(env, bottomRows, new Set(topRows.map(row => row.cache_key)));
    return {available: true, up, down, ratedTakes: Number(rated?.n) || 0, minSample: FEEDBACK_MIN_SAMPLE, top, bottom};
  } catch { return {available: false}; }
}

/** Client copy for the vote controls. Same rules as lighterClientScript: DOM APIs and
 * textContent only, no innerHTML, no eval, no cookies, no analytics. */
export const lighterFeedbackClientScript = `(function(){
 var copy={es:{up:'Me gusta esta sátira',down:'No me gusta esta sátira',saved:'¡Gracias por tu voto!',removed:'Tu voto se retiró.',fail:'No se pudo guardar el voto. Inténtalo de nuevo.',anon:'Voto anónimo por navegador: se guarda un token aleatorio en este navegador, nunca tu correo ni datos personales.'},en:{up:'I like this satire',down:'I dislike this satire',saved:'Thanks for your vote!',removed:'Your vote was removed.',fail:'Could not save the vote. Try again.',anon:'Anonymous per-browser vote: a random token is kept in this browser, never your email or personal data.'}};
 function langOf(ask){return ask&&ask.getAttribute('data-lighter-lang')==='en'?'en':'es';}
 function token(){
  try{
   var t=localStorage.getItem('prnews-lighter-vote-token');
   if(t&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(t))return t;
   if(typeof crypto==='undefined'||typeof crypto.randomUUID!=='function')return '';
   t=crypto.randomUUID();
   localStorage.setItem('prnews-lighter-vote-token',t);
   return t;
  }catch(e){return '';}
 }
 function digest(text){var h=0;for(var i=0;i<text.length;i++){h=(h*33+text.charCodeAt(i))|0;}return (h>>>0).toString(36);}
 function takeKey(url,lang,text){return lang+'|'+url+'|'+digest(text);}
 function saved(){try{var raw=localStorage.getItem('prnews-lighter-votes');var m=raw?JSON.parse(raw):{};return m&&typeof m==='object'?m:{};}catch(e){return {};}}
 function remember(k,v){try{var m=saved();if(v)m[k]=v;else delete m[k];var keys=Object.keys(m);if(keys.length>300)for(var i=0;i<keys.length-250;i++)delete m[keys[i]];localStorage.setItem('prnews-lighter-votes',JSON.stringify(m));}catch(e){}}
 function pressed(note,url,lang,text){
  var wrap=note.querySelector('.lighter-vote');if(!wrap)return;
  var current=saved()[takeKey(url,lang,text)]||'';
  var buttons=wrap.querySelectorAll('.lighter-vote-btn');
  for(var i=0;i<buttons.length;i++)buttons[i].setAttribute('aria-pressed',buttons[i].getAttribute('data-dir')===current?'true':'false');
 }
 function build(note,url,lang,text){
  if(!note||typeof note.appendChild!=='function')return;
  var line=note.querySelector('span');
  if(!line||!line.textContent||!line.textContent.replace(/^\\s+|\\s+$/g,''))return;
  var wrap=note.querySelector('.lighter-vote');
  if(!wrap){
   wrap=document.createElement('span');wrap.className='lighter-vote';
   for(var i=0;i<2;i++){
    var dir=i===0?'up':'down';
    var b=document.createElement('button');
    b.type='button';b.className='lighter-vote-btn '+(dir==='up'?'up':'down');
    b.textContent=dir==='up'?'\uD83D\uDC4D':'\uD83D\uDC4E';
    b.setAttribute('aria-label',copy[lang][dir]);
    b.setAttribute('aria-pressed','false');
    b.setAttribute('data-dir',dir);
    b.title=copy[lang].anon;
    wrap.appendChild(b);
   }
   var status=document.createElement('span');status.className='lighter-vote-note';wrap.appendChild(status);
   note.appendChild(wrap);
  }
  pressed(note,url,lang,text);
 }
 document.addEventListener('prnews:satire',function(event){
  var note=event.target,detail=event.detail||{};
  if(!note||!detail.url||!detail.text)return;
  build(note,detail.url,detail.lang==='en'?'en':'es',detail.text);
 });
 try{
  var notes=document.querySelectorAll('.lighter-note');
  for(var i=0;i<notes.length;i++){
   var note=notes[i],span=note.querySelector('span');
   if(!span)continue;
   var text=span.textContent.replace(/^\\s+|\\s+$/g,'');
   if(!text)continue;
   var ask=note.parentNode&&typeof note.parentNode.querySelector==='function'?note.parentNode.querySelector('.lighter-ask'):null;
   if(!ask)continue;
   build(note,ask.getAttribute('data-lighter-url')||'',langOf(ask),text);
  }
 }catch(e){}
 document.addEventListener('click',function(event){
  var target=event.target;
  var button=target&&target.closest?target.closest('.lighter-vote-btn'):null;
  if(!button)return;
  var note=button.closest('.lighter-note');if(!note)return;
  var wrap=button.closest('.lighter-vote');if(!wrap)return;
  var line=note.querySelector('span');
  var status=wrap.querySelector('.lighter-vote-note');
  function say(t){if(status)status.textContent=t;}
  if(!line||wrap.getAttribute('data-busy')==='1')return;
  var text=line.textContent.replace(/^\\s+|\\s+$/g,'');
  var ask=note.parentNode&&typeof note.parentNode.querySelector==='function'?note.parentNode.querySelector('.lighter-ask'):null;
  var url=ask?ask.getAttribute('data-lighter-url'):'';
  var lang=ask?langOf(ask):(document.documentElement.lang==='en'?'en':'es');
  if(!url||!text)return;
  var tok=token();
  if(!tok){say(copy[lang].fail);return;}
  var tk=takeKey(url,lang,text),prev=saved()[tk]||'';
  var next=prev===button.getAttribute('data-dir')?'none':button.getAttribute('data-dir');
  var all=wrap.querySelectorAll('.lighter-vote-btn');
  wrap.setAttribute('data-busy','1');
  for(var i=0;i<all.length;i++)all[i].disabled=true;
  fetch('/api/lighter-vote',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-PRNews-Action':'lighter-vote'},body:JSON.stringify({url:url,lang:lang,vote:next,token:tok})}).then(function(r){return r.json().then(function(p){return {ok:r.ok,status:r.status,payload:p};});}).then(function(result){
   wrap.removeAttribute('data-busy');
   for(var i=0;i<all.length;i++)all[i].disabled=false;
   var payload=result.payload||{};
   if(result.ok&&payload.status==='ok'){
    remember(tk,next==='none'?'':next);
    pressed(note,url,lang,text);
    say(next==='none'?copy[lang].removed:copy[lang].saved);
    return;
   }
   say(copy[lang].fail);
  }).catch(function(){
   wrap.removeAttribute('data-busy');
   for(var i=0;i<all.length;i++)all[i].disabled=false;
   say(copy[lang].fail);
  });
 });
})();`;
