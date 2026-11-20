import type {Env} from './ingest';
import {currentItem} from './current-item';
import type {Item} from './parse';
import {VERSION, key, valid} from './lighter';

/** Anonymous 👍/👎 on a displayed satire take.
 * A vote binds to the exact displayed generation: not just the lighter-2 cache key
 * (prompt version, URL, headline, excerpt, language) but the exact stored text. The
 * cache key alone cannot distinguish a regenerated take: a clearly-wrong-edition line
 * is cleared on the next explicit request and the same key can then hold a new,
 * different text. The server re-resolves the current take, computes the SHA-256 of
 * its trimmed text, and requires the client to name the same hash; anything else is
 * stale and answers 409 without writing. A regenerated take therefore starts with no
 * inherited ratings, while the old text's votes stay in the ledger, still counted in
 * the up/down totals and never reassigned to the replacement.
 * One current vote per browser per exact generation: the browser keeps a random UUID
 * in localStorage; the server stores only its SHA-256 hash and (token_hash, cache_key,
 * take_hash) is the primary key, so repeats are idempotent and changes move one row.
 * No email, IP, cookie, account, or fingerprint is read or stored. Votes never call
 * the model and never touch the generation budget or its removed global limits; the
 * single guard below (a global per-minute bucket) protects the counts only, because a
 * vote is one cheap D1 write and a hard in-flight cap would refuse honest voters.
 * GET never reaches a write. */

/** A take needs at least this many votes before /stats lists it as an example,
 * so one vote can never present a take as the best or worst. */
export const FEEDBACK_MIN_SAMPLE = 3;
/** Vote writes per UTC minute, across everyone (not per person, no address stored).
 * Generous for real readers, but it bounds flood writes to the vote ledger. */
export const FEEDBACK_RATE_PER_MINUTE = 60;
const BODY_LIMIT = 1000;
const TOKEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TAKE_HASH = /^[0-9a-f]{64}$/;

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

async function digestHex(prefix: string, value: string): Promise<string> {
  const bytes = new TextEncoder().encode(prefix + value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Domain-separated SHA-256, so the stored hash cannot be reused as any other feature's id. */
function tokenHash(token: string) {
  return digestHex('prnews-lighter-vote:', token);
}

/** SHA-256 of the exact displayed take text. This is the generation binding: two
 * different texts under the same cache key get different take hashes, so a vote
 * can never silently rate a replacement. The client computes the same hash over
 * the text it is showing; a mismatch is a stale client and is rejected. */
function takeHash(text: string) {
  return digestHex('prnews-lighter-take:', text);
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
    if (!take || !valid(take, item, lang)) return {cacheKey, take: '', takeHash: ''};
    return {cacheKey, take, takeHash: await takeHash(take)};
  } catch { return {cacheKey, take: '', takeHash: ''}; }
}

async function allowVoteRate(env: Env, now: number) {
  const bucket = Math.floor(now / 60000);
  await env.DB.prepare('DELETE FROM lighter_vote_rate WHERE bucket<?').bind(bucket - 2).run();
  const result = await env.DB.prepare('INSERT INTO lighter_vote_rate(bucket, hits) VALUES(?,1) ON CONFLICT(bucket) DO UPDATE SET hits=hits+1 WHERE hits<?').bind(bucket, FEEDBACK_RATE_PER_MINUTE).run();
  return changed(result);
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
  const record = body && typeof body === 'object' ? body as {url?: unknown; lang?: unknown; vote?: unknown; token?: unknown; take?: unknown} : {};
  const articleUrl = typeof record.url === 'string' && record.url.length >= 8 && record.url.length <= 2000 && /^https:\/\//.test(record.url) && !/[\u0000-\u001f\s]/.test(record.url) ? record.url : '';
  const lang: FeedbackEdition | '' = record.lang === 'es' || record.lang === 'en' ? record.lang : '';
  const vote: FeedbackVote | '' = record.vote === 'up' || record.vote === 'down' || record.vote === 'none' ? record.vote : '';
  const token = typeof record.token === 'string' && record.token.length <= 100 && TOKEN_ID.test(record.token) ? record.token.toLowerCase() : '';
  const displayed = typeof record.take === 'string' && record.take.length === 64 && TAKE_HASH.test(record.take) ? record.take.toLowerCase() : '';
  if (!articleUrl || !lang || !vote || !token || !displayed) return json({status: 'bad_request'}, 400);
  try {
    const item = await loadStored(env, articleUrl);
    if (!item) return json({status: 'unknown'}, 404);
    const take = await votableTake(env, item, lang);
    // Not the displayed take: superseded, hidden, or never generated. Never a write.
    if (!take.take) return json({status: 'gone'}, 409);
    // Stale client: the browser shows a different generation than the one stored now
    // (for example a replaced wrong-language line). The vote binds to the displayed
    // text, so it is rejected instead of silently rating the replacement.
    if (displayed !== take.takeHash) return json({status: 'stale'}, 409);
    if (!(await allowVoteRate(env, now))) return json({status: 'rate'}, 429);
    const hash = await tokenHash(token);
    if (vote === 'none') {
      await env.DB.prepare('DELETE FROM lighter_votes WHERE token_hash=? AND cache_key=? AND take_hash=?').bind(hash, take.cacheKey, take.takeHash).run();
    } else {
      await env.DB.prepare('INSERT INTO lighter_votes(token_hash,cache_key,take_hash,vote,voted_at) VALUES(?,?,?,?,?) ON CONFLICT(token_hash,cache_key,take_hash) DO UPDATE SET vote=excluded.vote, voted_at=excluded.voted_at').bind(hash, take.cacheKey, take.takeHash, vote, now).run();
    }
    console.info('lighter_vote', {lang, vote});
    return json({status: 'ok', vote});
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

type GroupRow = {cache_key: string; take_hash: string; ups: number; downs: number; n: number};

async function voteGroups(env: Env): Promise<GroupRow[]> {
  const rows = await env.DB.prepare(
    `SELECT cache_key, take_hash, COUNT(*) AS n,
            SUM(CASE WHEN vote='up' THEN 1 ELSE 0 END) AS ups,
            SUM(CASE WHEN vote='down' THEN 1 ELSE 0 END) AS downs
     FROM lighter_votes GROUP BY cache_key, take_hash`
  ).all<GroupRow>();
  return rows.results;
}

/** Aggregate read for /stats. A missing table or failed read is unavailable, never zero.
 * Totals count every stored vote — each row is one browser's current vote on one exact
 * generation, and a replaced text's votes stay in history instead of being reassigned.
 * The rated-take count and the examples bind to the current stored text only. */
export async function readLighterFeedback(env: Env): Promise<FeedbackView | {available: false}> {
  try {
    await env.DB.prepare('SELECT token_hash FROM lighter_votes LIMIT 1').first();
    const groups = await voteGroups(env);
    let up = 0, down = 0;
    for (const group of groups) { up += Number(group.ups) || 0; down += Number(group.downs) || 0; }
    const texts = await takeTexts(env, groups.map(group => group.cache_key));
    const currentHash = new Map<string, string>();
    for (const [cacheKey, text] of texts) currentHash.set(cacheKey, await takeHash(text));
    // Only votes whose take hash matches the currently stored text rate that text.
    const current = groups.filter(group => currentHash.get(group.cache_key) === group.take_hash);
    const ratedTakes = new Set(current.map(group => group.cache_key)).size;
    const order = (sign: 1 | -1) => current
      .filter(group => group.n >= FEEDBACK_MIN_SAMPLE && (group.ups - group.downs) * sign > 0)
      .sort((a, b) => (b.ups - b.downs) * sign - (a.ups - a.downs) * sign || b.n - a.n || (a.cache_key < b.cache_key ? -1 : 1))
      .slice(0, 3);
    const build = async (rows: GroupRow[]): Promise<FeedbackExample[]> => {
      const out: FeedbackExample[] = [];
      for (const row of rows) {
        const take = takeFromKey(row.cache_key);
        const text = texts.get(row.cache_key);
        if (!take || !text) continue;
        const item = {url: take.url, source: '', title: take.title, summary: take.summary, image: '', time: 0, observed: false, section: 'otras', reason: 'feedback'} as Item;
        // A take the current guard hides is not shown as an example, but its votes stay counted.
        if (!valid(text, item, take.lang)) continue;
        out.push({lang: take.lang, title: take.title, text, url: take.url, storyId: null, ups: Number(row.ups) || 0, downs: Number(row.downs) || 0});
      }
      return out;
    };
    const top = await build(order(1));
    const seen = new Set(order(1).map(row => row.cache_key));
    const bottom = await build(order(-1).filter(row => !seen.has(row.cache_key)));
    return {available: true, up, down, ratedTakes, minSample: FEEDBACK_MIN_SAMPLE, top, bottom};
  } catch { return {available: false}; }
}

/** Client copy for the vote controls. Same rules as lighterClientScript: DOM APIs and
 * textContent only, no innerHTML, no eval, no cookies, no analytics. */
export const lighterFeedbackClientScript = `(function(){
 var copy={es:{up:'Me gusta esta sátira',down:'No me gusta esta sátira',saved:'¡Gracias por tu voto!',removed:'Tu voto se retiró.',fail:'No se pudo guardar el voto. Inténtalo de nuevo.',stale:'Esta sátira ya no es la versión actual. Ocúltala y vuelve a mostrarla para votar sobre la nueva.',anon:'Voto anónimo por navegador: se guarda un token aleatorio en este navegador, nunca tu correo ni datos personales.'},en:{up:'I like this satire',down:'I dislike this satire',saved:'Thanks for your vote!',removed:'Your vote was removed.',fail:'Could not save the vote. Try again.',stale:'This satire is no longer the current version. Hide it and show it again to vote on the new one.',anon:'Anonymous per-browser vote: a random token is kept in this browser, never your email or personal data.'}};
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
 // SHA-256 of the exact displayed text, the same domain-separated digest the server
 // computes over the stored take. The vote names this hash, so it binds to the exact
 // generation the browser is showing; a replaced take answers stale instead of
 // silently receiving the old text's rating.
 function takeHash(text){
  try{
   if(typeof crypto==='undefined'||!crypto.subtle||typeof crypto.subtle.digest!=='function')return '';
   return crypto.subtle.digest('SHA-256',new TextEncoder().encode('prnews-lighter-take:'+text)).then(function(buffer){
    var bytes=new Uint8Array(buffer),out='',i;
    for(i=0;i<bytes.length;i++)out+=(bytes[i]<16?'0':'')+bytes[i].toString(16);
    return out;
   });
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
  function free(){wrap.removeAttribute('data-busy');for(var j=0;j<all.length;j++)all[j].disabled=false;}
  if(!line||wrap.getAttribute('data-busy')==='1')return;
  var text=line.textContent.replace(/^\\s+|\\s+$/g,'');
  var ask=note.parentNode&&typeof note.parentNode.querySelector==='function'?note.parentNode.querySelector('.lighter-ask'):null;
  var url=ask?ask.getAttribute('data-lighter-url'):'';
  var lang=ask?langOf(ask):(document.documentElement.lang==='en'?'en':'es');
  if(!url||!text)return;
  var tok=token();
  if(!tok){say(copy[lang].fail);return;}
  var hashed=takeHash(text);
  if(!hashed){say(copy[lang].fail);return;}
  var tk=takeKey(url,lang,text),prev=saved()[tk]||'';
  var next=prev===button.getAttribute('data-dir')?'none':button.getAttribute('data-dir');
  var all=wrap.querySelectorAll('.lighter-vote-btn');
  wrap.setAttribute('data-busy','1');
  for(var i=0;i<all.length;i++)all[i].disabled=true;
  hashed.then(function(take){
   return fetch('/api/lighter-vote',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-PRNews-Action':'lighter-vote'},body:JSON.stringify({url:url,lang:lang,vote:next,token:tok,take:take})}).then(function(r){return r.json().then(function(p){return {ok:r.ok,status:r.status,payload:p};});});
  }).then(function(result){
   free();
   var payload=result.payload||{};
   if(result.ok&&payload.status==='ok'){
    remember(tk,next==='none'?'':next);
    pressed(note,url,lang,text);
    say(next==='none'?copy[lang].removed:copy[lang].saved);
    return;
   }
   say(payload.status==='stale'||payload.status==='gone'?copy[lang].stale:copy[lang].fail);
  }).catch(function(){
   free();
   say(copy[lang].fail);
  });
 });
})();`;
