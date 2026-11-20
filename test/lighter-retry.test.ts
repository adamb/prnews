import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {expect, it, vi} from 'vitest';
import {key, lighterClientScript, lighterRoute} from '../src/lighter';
import renderer from '../src/render';
import type {Env} from '../src/ingest';
import type {Item} from '../src/parse';

const board = {url:'https://noticel.com/noticias/20261118/junta-de-supervision-fiscal-exige-transparencia-al-gobierno/', source:'noticel', title:'Junta de Supervisión Fiscal exige transparencia al Gobierno', summary:'Aunque asegura que sus asesores son contratados mediante procesos competitivos y que sus facturas están sujetas a revisiones independientes, el organismo no identificó a sus diez principales proveedores ni detalló cuánto dinero ha reducido o recuperado por cargos objetados. La Junta de Supervisión…', image:'', time:1, observed:false, section:'politica', reason:'test'} as Item;
const englishLine = 'The board scheduled another hearing to admire its own transparency form.';
const nestedSpanish = 'La Junta insiste en otra audiencia para admirar su propio formulario de transparencia.';

function database(): D1Database {
 const sqlite = new DatabaseSync(':memory:');
 for (const file of ['migrations/0001_live.sql','migrations/0011_lighter.sql','migrations/0012_lighter_stats.sql']) sqlite.exec(readFileSync(file,'utf8'));
 const prepare = (query: string) => {
  let args: any[] = [];
  return {bind(...values: any[]){args=values;return this;}, async first(){return sqlite.prepare(query).get(...args) ?? null;}, async all(){return {results: sqlite.prepare(query).all(...args)};}, async run(){const result = sqlite.prepare(query).run(...args); return {meta:{changes:Number(result.changes)}};}};
 };
 return {prepare, async batch(statements: Array<{run:()=>Promise<unknown>}>){return Promise.all(statements.map(statement=>statement.run()));}} as unknown as D1Database;
}
function post(env: Env, body: unknown, now: number) {
 return lighterRoute(new Request('https://news.dev.pr/api/lighter', {method:'POST', headers:{Origin:'https://news.dev.pr','Content-Type':'application/json','X-PRNews-Action':'lighter','Sec-Fetch-Site':'same-origin'}, body:JSON.stringify(body)}), env, now) as Promise<Response>;
}

it('waits out the NotiCel English cooldown instead of calling the model again', async () => {
 const DB = database();
 const now = Date.UTC(2026, 10, 18, 12, 7, 33);
 await DB.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)').bind(board.url, board.source, JSON.stringify(board), now, now, now).run();
 await DB.prepare('INSERT INTO lighter_cache(key,text,attempts,next_try) VALUES(?,?,?,?)').bind(key(board,'en'), null, 1, now + 3000 * 1000).run();
 const run = vi.fn(async (_model: string, options: {messages:{content:string}[]}) => ({response:{text:{sentence:englishLine}}}));
 const env = {DB, AI:{run}} as unknown as Env;
 const cooled = await post(env, {url:board.url, lang:'en', action:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'}, now);
 expect(cooled.status).toBe(200);
 expect(await cooled.json()).toEqual({status:'cooldown', retry_after:3000});
 expect(run).not.toHaveBeenCalled();
 const row = await DB.prepare('SELECT text, attempts, next_try FROM lighter_cache WHERE key=?').bind(key(board,'en')).first<{text:string|null;attempts:number;next_try:number}>();
 expect(row).toEqual({text:null, attempts:1, next_try:now + 3000 * 1000});
 const ready = await post(env, {url:board.url, lang:'en', action:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'}, now + 3000 * 1000);
 expect(await ready.json()).toEqual({status:'ready', text:englishLine});
 expect(run).toHaveBeenCalledTimes(1);
 const sent = run.mock.calls[0][1];
 expect(JSON.stringify(sent)).toContain('English');
 expect(JSON.stringify(sent)).toContain(board.title);
 const saved = await DB.prepare('SELECT text, attempts FROM lighter_cache WHERE key=?').bind(key(board,'en')).first<{text:string;attempts:number}>();
 expect(saved).toEqual({text:englishLine, attempts:2});
});

it('rejects a nested Spanish sentence and still stores a nested English one', async () => {
 const DB = database();
 await DB.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)').bind(board.url, board.source, JSON.stringify(board), 1, 1, 1).run();
 const run = vi.fn()
  .mockResolvedValueOnce({response:{text:{sentence:nestedSpanish}}})
  .mockResolvedValueOnce({response:{text:{content:englishLine}}});
 const env = {DB, AI:{run}} as unknown as Env;
 const now = Date.UTC(2026, 10, 18, 13, 0, 0);
 const rejected = await post(env, {url:board.url, lang:'en', action:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'}, now);
 expect(await rejected.json()).toEqual({status:'cooldown', retry_after:3600});
 expect(await DB.prepare('SELECT text FROM lighter_cache WHERE key=?').bind(key(board,'en')).first<{text:string|null}>()).toEqual({text:null});
 const accepted = await post(env, {url:board.url, lang:'en', action:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'}, now + 3600 * 1000);
 expect(await accepted.json()).toEqual({status:'ready', text:englishLine});
 expect(run).toHaveBeenCalledTimes(2);
});

it('shows the English wait, then a real retry, and does not offer one when the story or the day is done', async () => {
 const note = {textContent:'', appendChild(node: unknown){ this.nodes.push(node); }, nodes:[] as unknown[]};
 const button = {
  disabled:false,
  textContent:'Show satire',
  attrs:{'data-lighter-lang':'en','data-lighter-url':board.url,'data-cached':'0'} as Record<string, string>,
  parentNode:{querySelector:()=>note},
  setAttribute(name: string, value: string){ this.attrs[name] = String(value); },
  getAttribute(name: string){ return this.attrs[name] ?? null; },
  removeAttribute(name: string){ delete this.attrs[name]; },
  closest(selector: string){ return selector === '.lighter-ask' ? button : null; },
 };
 const listeners: Record<string, (event: {target: unknown}) => void> = {};
 const timers = new Map<number, {fn: () => void; ms: number; cleared: boolean}>();
 let nextId = 1;
 const fetchMock = vi.fn(async () => ({ok:true, status:200, json:async () => ({status:'cooldown', retry_after:3000})}));
 const previous = {document: globalThis.document, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout};
 const flush = () => new Promise(resolve => previous.setTimeout(resolve, 0));
 globalThis.document = {addEventListener(type: string, fn: (event: {target: unknown}) => void){ listeners[type] = fn; }} as unknown as Document;
 globalThis.fetch = fetchMock as unknown as typeof fetch;
 globalThis.setTimeout = ((fn: () => void, ms?: number) => { const id = nextId++; timers.set(id, {fn, ms: ms ?? 0, cleared:false}); return id; }) as unknown as typeof setTimeout;
 globalThis.clearTimeout = ((id?: number) => { const timer = timers.get(id ?? 0); if (timer) timer.cleared = true; }) as unknown as typeof clearTimeout;
 try {
  eval(lighterClientScript);
  listeners.click({target: button});
  await fetchMock.mock.results[0].value;
  await flush();
  await flush();
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe('Try again later');
  expect(button.getAttribute('data-mode')).toBe('wait');
  expect(note.textContent).not.toContain('Try again.');
  listeners.click({target: button});
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const wait = [...timers.values()].find(timer => timer.ms === 3000 * 1000 && !timer.cleared);
  expect(wait).toBeTruthy();
  wait?.fn();
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe('Try again');
  expect(button.getAttribute('data-mode')).toBe('retry');
 } finally {
  globalThis.document = previous.document;
  globalThis.fetch = previous.fetch;
  globalThis.setTimeout = previous.setTimeout;
  globalThis.clearTimeout = previous.clearTimeout;
 }
});

it.each([
 ['budget', 'Not available today', "Today's satire limit is used up"],
 ['exhausted', 'Not available', "Satire isn't available for this story"],
] as const)('leaves %s with the button off', async (status, label, noteText) => {
 const note = {textContent:''};
 const button = {
  disabled:false,
  textContent:'Show satire',
  attrs:{'data-lighter-lang':'en','data-lighter-url':board.url,'data-cached':'0'} as Record<string, string>,
  parentNode:{querySelector:()=>note},
  setAttribute(name: string, value: string){ this.attrs[name] = String(value); },
  getAttribute(name: string){ return this.attrs[name] ?? null; },
  removeAttribute(name: string){ delete this.attrs[name]; },
  closest(selector: string){ return selector === '.lighter-ask' ? button : null; },
 };
 const listeners: Record<string, (event: {target: unknown}) => void> = {};
 const fetchMock = vi.fn(async () => ({ok:status!=='budget', status:status==='budget'?429:200, json:async () => ({status})}));
 const previous = {document: globalThis.document, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout};
 const flush = () => new Promise(resolve => previous.setTimeout(resolve, 0));
 globalThis.document = {addEventListener(type: string, fn: (event: {target: unknown}) => void){ listeners[type] = fn; }} as unknown as Document;
 globalThis.fetch = fetchMock as unknown as typeof fetch;
 globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
 globalThis.clearTimeout = (() => undefined) as unknown as typeof clearTimeout;
 try {
  eval(lighterClientScript);
  listeners.click({target: button});
  await fetchMock.mock.results[0].value;
  await flush();
  await flush();
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe(label);
  expect(button.getAttribute('data-mode')).toBe('done');
  listeners.click({target: button});
  expect(fetchMock).toHaveBeenCalledTimes(1);
 } finally {
  globalThis.document = previous.document;
  globalThis.fetch = previous.fetch;
  globalThis.setTimeout = previous.setTimeout;
  globalThis.clearTimeout = previous.clearTimeout;
 }
});

it('restores one show label after hide, whether or not a line is cached', () => {
 const note = {textContent:''};
 const button = {
  disabled:false,
  textContent:'Hide satire',
  attrs:{'data-lighter-lang':'en','data-lighter-url':board.url,'data-cached':'1','data-mode':'open','aria-expanded':'true'} as Record<string, string>,
  parentNode:{querySelector:()=>note},
  setAttribute(name: string, value: string){ this.attrs[name] = String(value); },
  getAttribute(name: string){ return this.attrs[name] ?? null; },
  removeAttribute(name: string){ delete this.attrs[name]; },
  closest(selector: string){ return selector === '.lighter-ask' ? button : null; },
 };
 const listeners: Record<string, (event: {target: unknown}) => void> = {};
 const previous = globalThis.document;
 globalThis.document = {addEventListener(type: string, fn: (event: {target: unknown}) => void){ listeners[type] = fn; }} as unknown as Document;
 try {
  eval(lighterClientScript);
  listeners.click({target: button});
  expect(button.textContent).toBe('Show satire');
  expect(button.getAttribute('data-mode')).toBe('closed');
  expect(button.getAttribute('data-cached')).toBe('1');
  expect(button.getAttribute('aria-expanded')).toBe('false');
  button.setAttribute('data-cached', '0');
  button.setAttribute('data-mode', 'open');
  button.textContent = 'Hide satire';
  listeners.click({target: button});
  expect(button.textContent).toBe('Show satire');
  expect(button.getAttribute('data-cached')).toBe('0');
  button.setAttribute('data-lighter-lang', 'es');
  button.setAttribute('data-mode', 'open');
  listeners.click({target: button});
  expect(button.textContent).toBe('Mostrar sátira');
  expect(lighterClientScript).not.toContain('guardada');
  expect(lighterClientScript).not.toContain('saved satire');
 } finally {
  globalThis.document = previous;
 }
});

it('ships the wait copy with the English card and keeps the satire out of the HTML', async () => {
 const html = await renderer.fetch(new Request('https://news.dev.pr/?lang=en'), {items:[board], translations:{[board.url]:{originalTitle:board.title, originalSummary:board.summary, title:'Fiscal Supervision Board Demands Transparency from Government', summary:'The board demands transparency.'}}, feeds:[]}).text();
 expect(html).toContain('Fiscal Supervision Board Demands Transparency from Government');
 expect(html).toContain(`data-lighter-url="${board.url}" data-lighter-lang="en"`);
 expect(html).toContain('Show satire');
 expect(html).toContain('Hide satire');
 expect(html).not.toContain('Ask for a satire');
 expect(html).not.toContain('Show the saved satire');
 expect(html).toContain("Satire isn't ready yet. You can try again in about # minutes.");
 expect(html).toContain('Not available today');
 expect(html).toContain("Satire isn't available for this story.");
 expect(html).not.toContain(englishLine);
 expect(html).not.toContain('innerHTML');
});
