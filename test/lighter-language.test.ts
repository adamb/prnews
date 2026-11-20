import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {expect, it, vi} from 'vitest';
import worker from '../src/index';
import {key, lighterRoute, satirePrompt, valid} from '../src/lighter';
import {readLighterQueue, readySnapshot} from '../src/lighter-stats';
import {sentenceEdition, type Item} from '../src/parse';
import renderer from '../src/render';
import type {Env} from '../src/ingest';

const spanishTake = 'PRITS ahora ofrece capacitación para que los servidores públicos puedan mantenerse al día con la velocidad de la burocracia.';
const beckhamTake = 'Una fragancia de lujo en una gasolinera, porque nada dice elegancia como el olor a gasolina.';
const governorTake = "Government agency defends official's decision to stay until December 31, despite earlier intention to resign.";
const symposiumTake = "Bureaucratic milestone celebrated with symposium, because what's a decade of oversight without a panel discussion?";
const teachersTake = 'Teachers in Puerto Rico are protesting for salary improvements and debt payment.';
const maestrosTake = 'Maestros en Puerto Rico realizan manifestaciones para exigir mejoras salariales y pago de deudas.';
const englishTake = 'The bureau at PRITS Academy scheduled another course about its own course.';
const namedEnglish = 'The bureau briefed WIPR and Suzanne Roig before the PRITS Academy course.';
const namedSpanish = 'La agencia WIPR insiste en que PRITS Academy ya ofreció la capacitación.';
const nameLead = 'Manatí files the form after Rosalía calls the bureau.';
const ambiguous = 'PRITS Academy briefing.';

const spanishStory = {url:'https://wipr.pr/prits-academy/', source:'wipr', title:'PRITS lanza PRITS Academy para fortalecer las competencias tecnológicas de los servidores públicos', summary:'La agencia anunció cursos de capacitación para los servidores públicos.', image:'', time:1, observed:false, section:'politica', reason:'test'} as Item;
const englishStory = {url:'https://www.sanjuandailystar.com/post/symposium/', source:'sjds', title:'Center plans a symposium on oversight', summary:'The center announced a symposium after a decade of oversight.', image:'', time:1, observed:false, section:'politica', reason:'test'} as Item;
const quoted = 'The agency said "delay is policy" today and filed it.';

function database(): D1Database {
 const sqlite = new DatabaseSync(':memory:');
 for (const file of ['migrations/0001_live.sql','migrations/0011_lighter.sql','migrations/0012_lighter_stats.sql']) sqlite.exec(readFileSync(file,'utf8'));
 sqlite.exec('CREATE TABLE IF NOT EXISTS story_ids (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE)');
 const prepare = (query: string) => {
  let args: any[] = [];
  return {bind(...values: any[]){args=values;return this;}, async first(){return sqlite.prepare(query).get(...args) ?? null;}, async all(){return {results: sqlite.prepare(query).all(...args)};}, async run(){const result = sqlite.prepare(query).run(...args); return {meta:{changes:Number(result.changes)}};}};
 };
 return {prepare, async batch(statements: Array<{run:()=>Promise<unknown>}>){return Promise.all(statements.map(s=>s.run()));}} as unknown as D1Database;
}
async function store(db: D1Database, item: Item) {
 await db.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)').bind(item.url, item.source, JSON.stringify(item), 1, 1, 1).run();
}
function post(env: Env, body: unknown, now?: number) {
 const request = new Request('https://news.dev.pr/api/lighter', {method:'POST', headers:{Origin:'https://news.dev.pr','Content-Type':'application/json','X-PRNews-Action':'lighter','Sec-Fetch-Site':'same-origin'}, body:JSON.stringify(body)});
 return now === undefined ? worker.fetch(request, env) : lighterRoute(request, env, now) as Promise<Response>;
}

it('accepts the edition the reader asked for and ignores proper names', () => {
 expect(sentenceEdition(spanishTake)).toBe('es');
 expect(sentenceEdition(beckhamTake)).toBe('es');
 expect(sentenceEdition(maestrosTake)).toBe('es');
 expect(sentenceEdition(namedSpanish)).toBe('es');
 expect(sentenceEdition(governorTake)).toBe('en');
 expect(sentenceEdition(symposiumTake)).toBe('en');
 expect(sentenceEdition(teachersTake)).toBe('en');
 expect(sentenceEdition(englishTake)).toBe('en');
 expect(sentenceEdition(namedEnglish)).toBe('en');
 expect(sentenceEdition(nameLead)).toBe('en');
 expect(sentenceEdition(ambiguous)).toBeUndefined();
 expect(valid(spanishTake, spanishStory, 'en')).toBe(false);
 expect(valid(spanishTake, spanishStory, 'es')).toBe(true);
 expect(valid(englishTake, spanishStory, 'en')).toBe(true);
 expect(valid(englishTake, spanishStory, 'es')).toBe(false);
 expect(valid(namedEnglish, spanishStory, 'en')).toBe(true);
 expect(valid(namedSpanish, spanishStory, 'es')).toBe(true);
 expect(valid(namedSpanish, spanishStory, 'en')).toBe(false);
 expect(valid(nameLead, englishStory, 'en')).toBe(true);
 expect(valid(teachersTake, spanishStory, 'en')).toBe(true);
 expect(valid(maestrosTake, spanishStory, 'es')).toBe(true);
 expect(valid(maestrosTake, spanishStory, 'en')).toBe(false);
 expect(satirePrompt('en')).toContain('must be English');
 expect(satirePrompt('en')).toContain('even when the headline and excerpt are Spanish');
 expect(satirePrompt('es')).toContain('must be Spanish');
 expect(satirePrompt('es')).toContain('even when the headline and excerpt are English');
 expect(satirePrompt('en')).toContain('outputLanguage');
 expect(satirePrompt('en')).not.toContain('Onion');
});

it('asks in the page language and does not clamp the satire note', async () => {
 const translation = {[spanishStory.url]: {originalTitle: spanishStory.title, originalSummary: spanishStory.summary, title:"PRITS Launches PRITS Academy to Strengthen Public Servants' Technological Competencies", summary:'The agency announced training for public servants.'}};
 const data = {items:[spanishStory, englishStory], translations:translation, feeds:[], lighter:{[key(spanishStory,'en')]: spanishTake, [key(spanishStory,'es')]: spanishTake, [key(englishStory,'en')]: englishTake}};
 const english = await renderer.fetch(new Request('https://news.dev.pr/?lang=en'), data).text();
 expect(english).toContain(`data-lighter-url="${spanishStory.url}" data-lighter-lang="en" data-cached="0"`);
 expect(english).toContain(`data-lighter-url="${englishStory.url}" data-lighter-lang="en" data-cached="1"`);
 expect(english).toContain('Ask for a satire');
 expect(english).toContain('Show the saved satire');
 expect(english).toContain('lang:langOf(button)');
 expect(english).not.toContain(spanishTake);
 expect(english).toContain('.card p.lighter-note{display:block;overflow:visible');
 expect(english).toContain('-webkit-line-clamp:unset');
 expect(english).toContain('-webkit-line-clamp:3');
 expect(english).toContain('text-overflow:ellipsis');
 const spanish = await renderer.fetch(new Request('https://news.dev.pr/'), data).text();
 expect(spanish).toContain(`data-lighter-url="${spanishStory.url}" data-lighter-lang="es" data-cached="1"`);
 expect(spanish).toContain('Ver la sátira guardada');
 expect(spanish).not.toContain(englishTake);
});

it('rejects a Spanish sentence for an English view of a Spanish article and does not cache it', async () => {
 const DB = database();
 await store(DB, spanishStory);
 const run = vi.fn(async (_model: string, options: {messages:{content:string}[]}) => {
  const body = JSON.parse(options.messages[1].content) as {outputLanguage:string;title:string;excerpt:string};
  expect(body.outputLanguage).toBe('English');
  expect(body.title).toBe(spanishStory.title);
  expect(body.excerpt).toBe(spanishStory.summary);
  expect(options.messages[0].content).toContain('must be English');
  return {response: JSON.stringify({text: spanishTake})};
 });
 const env = {DB, AI:{run}} as unknown as Env;
 const now = Date.UTC(2026, 10, 17, 18, 0, 0);
 const failed = await post(env, {url:spanishStory.url, lang:'en', action:'11111111-1111-4111-8111-111111111111'}, now);
 expect(failed?.status).toBe(200);
 const failedBody = await failed?.json();
 expect(failedBody).toEqual({status:'cooldown', retry_after:3600});
 expect(JSON.stringify(failedBody)).not.toContain('ahora ofrece');
 expect(run).toHaveBeenCalledTimes(1);
 const row = await DB.prepare('SELECT text, attempts FROM lighter_cache WHERE key=?').bind(key(spanishStory,'en')).first<{text:string|null;attempts:number}>();
 expect(row?.text).toBeNull();
 expect(row?.attempts).toBe(1);
 const again = await post(env, {url:spanishStory.url, lang:'en', action:'22222222-2222-4222-8222-222222222222'}, now + 1000);
 expect(await again?.json()).toEqual({status:'cooldown', retry_after:3599});
 expect(run).toHaveBeenCalledTimes(1);
 const totals = await DB.prepare("SELECT failures, generations, attempts FROM lighter_stats WHERE scope='en'").first<{failures:number;generations:number;attempts:number}>();
 expect(totals).toEqual({failures:1, generations:0, attempts:1});
});

it('rejects an English sentence for a Spanish view of an English article', async () => {
 const DB = database();
 await store(DB, englishStory);
 const run = vi.fn(async (_model: string, options: {messages:{content:string}[]}) => ({response: JSON.stringify({text: symposiumTake})}));
 const env = {DB, AI:{run}} as unknown as Env;
 const now = Date.UTC(2026, 10, 17, 18, 10, 0);
 const failed = await post(env, {url:englishStory.url, lang:'es', action:'33333333-3333-4333-8333-333333333333'}, now);
 expect(await failed?.json()).toEqual({status:'cooldown', retry_after:3600});
 expect(run).toHaveBeenCalledTimes(1);
 const saved = await DB.prepare('SELECT text FROM lighter_cache WHERE key=?').bind(key(englishStory,'es')).first<{text:string|null}>();
 expect(saved?.text).toBeNull();
 const prompt = run.mock.calls[0][1];
 expect(prompt.messages[0].content).toContain('must be Spanish');
 expect(JSON.parse(prompt.messages[1].content).outputLanguage).toBe('Spanish');
 expect(JSON.parse(prompt.messages[1].content).title).toBe(englishStory.title);
});

it('stores a matching edition either way and keeps the other edition', async () => {
 const DB = database();
 await store(DB, spanishStory);
 await store(DB, englishStory);
 const run = vi.fn(async (_model: string, options: {messages:{content:string}[]}) => {
  const body = JSON.parse(options.messages[1].content) as {outputLanguage:string;title:string};
  if (body.outputLanguage === 'English' && body.title === spanishStory.title) return {response: JSON.stringify({text: englishTake})};
  if (body.outputLanguage === 'Spanish' && body.title === englishStory.title) return {response: JSON.stringify({text: namedSpanish})};
  return {response: JSON.stringify({text: ''})};
 });
 const env = {DB, AI:{run}} as unknown as Env;
 const now = Date.UTC(2026, 10, 17, 18, 20, 0);
 const en = await post(env, {url:spanishStory.url, lang:'en', action:'44444444-4444-4444-8444-444444444444'}, now);
 expect(await en?.json()).toEqual({status:'ready', text:englishTake});
 const es = await post(env, {url:englishStory.url, lang:'es', action:'55555555-5555-4555-8555-555555555555'}, now);
 expect(await es?.json()).toEqual({status:'ready', text:namedSpanish});
 expect(run).toHaveBeenCalledTimes(2);
 expect(await DB.prepare('SELECT text FROM lighter_cache WHERE key=?').bind(key(spanishStory,'es')).first()).toBeNull();
 expect((await DB.prepare('SELECT text FROM lighter_cache WHERE key=?').bind(key(englishStory,'en')).first<{text:string|null}>())?.text ?? null).toBeNull();
});

it('replaces only a wrong-language cache cell and will not serve it from the other action', async () => {
 const DB = database();
 await store(DB, spanishStory);
 await DB.prepare('INSERT INTO lighter_cache(key,text,attempts,next_try) VALUES(?,?,?,?)').bind(key(spanishStory,'en'), spanishTake, 3, 0).run();
 await DB.prepare('INSERT INTO lighter_cache(key,text,attempts,next_try) VALUES(?,?,?,?)').bind(key(spanishStory,'es'), spanishTake, 1, 0).run();
 await DB.prepare('UPDATE articles SET published_at=?, translation=? WHERE url=?').bind(Date.now(), JSON.stringify({originalTitle:spanishStory.title, originalSummary:spanishStory.summary, title:'PRITS Launches PRITS Academy', summary:'The agency announced training for public servants.'}), spanishStory.url).run();
 const run = vi.fn(async () => ({response: JSON.stringify({text: namedEnglish})}));
 const env = {DB, AI:{run}} as unknown as Env;
 const now = Date.UTC(2026, 10, 17, 18, 30, 0);
 const home = await worker.fetch(new Request('https://news.dev.pr/?lang=en'), env);
 expect(home.status).toBe(200);
 const homeHtml = await home.text();
 expect(homeHtml).toContain('data-lighter-lang="en" data-cached="0"');
 expect(homeHtml).toContain('Ask for a satire');
 expect(homeHtml).not.toContain(spanishTake);
 expect(run).not.toHaveBeenCalled();
 expect(await DB.prepare('SELECT text FROM lighter_cache WHERE key=?').bind(key(spanishStory,'en')).first<{text:string}>()).toEqual({text:spanishTake});
 const esAction = '66666666-6666-4666-8666-666666666666';
 const spanish = await post(env, {url:spanishStory.url, lang:'es', action:esAction}, now);
 expect(await spanish?.json()).toEqual({status:'ready', text:spanishTake});
 expect(run).not.toHaveBeenCalled();
 const crossed = await post(env, {url:spanishStory.url, lang:'en', action:esAction}, now + 1000);
 const crossedBody = await crossed?.json();
 expect(crossedBody).toEqual({status:'unavailable'});
 expect(JSON.stringify(crossedBody)).not.toContain('capacitación');
 expect(run).not.toHaveBeenCalled();
 expect((await DB.prepare('SELECT text, attempts FROM lighter_cache WHERE key=?').bind(key(spanishStory,'en')).first<{text:string|null;attempts:number}>())).toEqual({text:null, attempts:0});
 expect(await DB.prepare('SELECT text FROM lighter_cache WHERE key=?').bind(key(spanishStory,'es')).first<{text:string}>()).toEqual({text:spanishTake});
 const enAction = '77777777-7777-4777-8777-777777777777';
 const english = await post(env, {url:spanishStory.url, lang:'en', action:enAction}, now + 2000);
 expect(await english?.json()).toEqual({status:'ready', text:namedEnglish});
 expect(run).toHaveBeenCalledTimes(1);
 const replay = await post(env, {url:spanishStory.url, lang:'en', action:enAction}, now + 3000);
 expect(await replay?.json()).toEqual({status:'ready', text:namedEnglish});
 expect(run).toHaveBeenCalledTimes(1);
 expect(await DB.prepare('SELECT text FROM lighter_cache WHERE key=?').bind(key(spanishStory,'es')).first<{text:string}>()).toEqual({text:spanishTake});
 const quotedRow = quoted;
 await DB.prepare('INSERT INTO lighter_cache(key,text,attempts,next_try) VALUES(?,?,?,?)').bind(key(englishStory,'en'), quotedRow, 1, 0).run();
 await store(DB, englishStory);
 const kept = await post(env, {url:englishStory.url, lang:'en', action:'88888888-8888-4888-8888-888888888888'}, now + 4000);
 expect(await kept?.json()).toEqual({status:'exhausted'});
 expect(await DB.prepare('SELECT text FROM lighter_cache WHERE key=?').bind(key(englishStory,'en')).first<{text:string}>()).toEqual({text:quotedRow});
 expect(run).toHaveBeenCalledTimes(1);
});

it('does not count a wrong-language line as ready and does not delete an unclear one', async () => {
 const snap = readySnapshot([spanishStory], {[key(spanishStory,'en')]: spanishTake, [key(spanishStory,'es')]: spanishTake}, true);
 expect(snap.available && snap.ready).toEqual({es:1, en:0});
 const DB = database();
 await store(DB, spanishStory);
 await DB.prepare('INSERT INTO lighter_cache(key,text,attempts,next_try) VALUES(?,?,?,?)').bind(key(spanishStory,'en'), ambiguous, 1, 0).run();
 await DB.prepare('INSERT INTO lighter_cache(key,text,attempts,next_try) VALUES(?,?,?,?)').bind(key(spanishStory,'es'), spanishTake, 1, 0).run();
 const queue = await readLighterQueue({DB} as Env, 10);
 expect(queue.available && queue.withheld).toEqual({es:0, en:1});
 const run = vi.fn();
 const now = Date.UTC(2026, 10, 17, 18, 40, 0);
 const response = await post({DB, AI:{run}} as unknown as Env, {url:spanishStory.url, lang:'en', action:'99999999-9999-4999-8999-999999999999'}, now);
 expect(await response?.json()).toEqual({status:'exhausted'});
 expect(run).not.toHaveBeenCalled();
 expect(await DB.prepare('SELECT text FROM lighter_cache WHERE key=?').bind(key(spanishStory,'en')).first<{text:string}>()).toEqual({text:ambiguous});
 expect(await DB.prepare('SELECT text FROM lighter_cache WHERE key=?').bind(key(spanishStory,'es')).first<{text:string}>()).toEqual({text:spanishTake});
});
