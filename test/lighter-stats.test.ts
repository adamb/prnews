import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {expect, it, vi} from 'vitest';
import {articleEligible, cacheSkips, generate, key} from '../src/lighter';
import {attachStoryIds, readLighterLedger, readLighterQueue, readySnapshot, type LighterView} from '../src/lighter-stats';
import renderer from '../src/render';
import worker from '../src/index';
import type {Env} from '../src/ingest';
import type {Item} from '../src/parse';

const takeEn='The agency reports delays on the roads.';
const takeEs='La agencia informa demoras en las carreteras.';
const story=(url:string, title:string, summary:string, published=1):Item=>({url, source:'noticel', title, summary, image:'', time:published, observed:false, section:'politica', reason:'test'});

function database(extra='', files=['migrations/0001_live.sql','migrations/0011_lighter.sql']): D1Database {
 const sqlite=new DatabaseSync(':memory:');
 for (const file of files) sqlite.exec(readFileSync(file,'utf8'));
 if(extra)sqlite.exec(extra);
 const prepare=(query:string)=>{
  let args:any[]=[];
  return {bind(...values:any[]){args=values;return this;},async first(){return sqlite.prepare(query).get(...args)??null;},async all(){return {results:sqlite.prepare(query).all(...args)};},async run(){const result=sqlite.prepare(query).run(...args);return {meta:{changes:Number(result.changes)}};}};
 };
 return {prepare, async batch(statements:Array<{run:()=>Promise<unknown>}>){return Promise.all(statements.map(s=>s.run()));}} as unknown as D1Database;
}
const insertArticle=async(db:D1Database,item:Item,published:number)=>db.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)').bind(item.url,item.source,JSON.stringify(item),published,published,published).run();
const insertCache=async(db:D1Database,cacheKey:string,text:string|null,attempts:number,nextTry:number)=>db.prepare('INSERT INTO lighter_cache(key,text,attempts,next_try) VALUES(?,?,?,?)').bind(cacheKey,text,attempts,nextTry).run();

it('shares the generator skip rules',()=>{
 const plain=story('https://example.com/a','Traffic delays','The agency reports traffic delays.');
 expect(articleEligible(plain)).toBe(true);
 expect(articleEligible({...plain,title:'x'.repeat(501)})).toBe(false);
 expect(articleEligible({...plain,summary:''})).toBe(false);
 expect(articleEligible({...plain,summary:'x'.repeat(301)})).toBe(false);
 expect(articleEligible({...plain,title:'Two dead after outage'})).toBe(false);
 expect(cacheSkips(null,10)).toBe(false);
 expect(cacheSkips({text:null,attempts:1,next_try:10},10)).toBe(false);
 expect(cacheSkips({text:null,attempts:1,next_try:11},10)).toBe(true);
 expect(cacheSkips({text:null,attempts:3,next_try:0},10)).toBe(true);
 expect(cacheSkips({text:takeEn,attempts:1,next_try:0},10)).toBe(true);
});

it('counts only current-version ready takes and classifies the same queue generate uses',async()=>{
 const now=10_000_000;
 const current=story('https://example.com/stale','Traffic delays','The agency reports traffic delays today.',800);
 const pending=story('https://example.com/pending','Bridge maintenance','Crews schedule bridge maintenance.',700);
 const retry=story('https://example.com/retry','Office paperwork','The office delayed the paperwork.',600);
 const failed=story('https://example.com/failed','Power paperwork','The utility delayed a form.',500);
 const ready=story('https://example.com/ready','Road work','Crews repave the main road.',400);
 const withheld=story('https://example.com/withheld','Budget hearing','The hearing covers the agency budget.',300);
 const sensitive=story('https://example.com/sensitive','Two dead after outage','Officials describe the outage.',900);
 const DB=database();
 for (const [item,published] of [[current,800],[pending,700],[retry,600],[failed,500],[ready,400],[withheld,300],[sensitive,900]] as [Item,number][]) await insertArticle(DB,item,published);
 await insertCache(DB,key({...current,summary:'Old excerpt about traffic only.'},'es'),takeEs,1,0);
 await insertCache(DB,key(retry,'es'),null,1,now+50_000);
 await insertCache(DB,key(retry,'en'),null,1,now+50_000);
 await insertCache(DB,key(failed,'es'),null,3,now-1);
 await insertCache(DB,key(failed,'en'),null,3,now-1);
 await insertCache(DB,key(ready,'es'),takeEs,1,0);
 await insertCache(DB,key(ready,'en'),takeEn,1,0);
 await insertCache(DB,key(withheld,'es'),'nope',1,0);
 await insertCache(DB,key(withheld,'en'),'nope',1,0);
 const snap=readySnapshot([current,pending,retry,failed,ready,withheld,sensitive],{
  [key({...current,summary:'Old excerpt about traffic only.'},'es')]:takeEs,
  [key(ready,'es')]:takeEs,
  [key(ready,'en')]:takeEn,
  [key(sensitive,'en')]:takeEn,
 },true);
 expect(snap.available).toBe(true);
 if(!snap.available)return;
 expect(snap.ready).toEqual({es:1,en:1});
 expect(snap.examples.map(example=>example.url)).toEqual([ready.url,ready.url]);
 const queue=await readLighterQueue({DB} as Env,now);
 expect(queue.available).toBe(true);
 if(!queue.available)return;
 expect(queue.pending).toEqual({es:2,en:2});
 expect(queue.retry).toEqual({es:1,en:1});
 expect(queue.failed).toEqual({es:1,en:1});
 expect(queue.withheld).toEqual({es:1,en:1});
 const run=vi.fn(async(_model:string,options:{messages:{content:string}[]})=>({response:JSON.stringify({text:takeEn})}));
 await generate({DB,AI:{run}} as unknown as Env,now);
 expect(run).toHaveBeenCalledTimes(2);
 const sent=run.mock.calls.map(call=>String(call[1].messages[1].content)).join('\n');
 expect(sent).toContain(current.summary);
 expect(sent).not.toContain(pending.title);
});

it('keeps a failed or missing ledger unavailable and a real zero attached to its start',async()=>{
 const missing=await readLighterLedger({DB:{prepare(){throw new Error('no such table: lighter_stats');}}} as unknown as Env);
 expect(missing).toEqual({available:false});
 const emptyDb=database('CREATE TABLE lighter_stats(scope TEXT PRIMARY KEY, started_at INTEGER NOT NULL, interactions INTEGER NOT NULL, cache_hits INTEGER NOT NULL, attempts INTEGER NOT NULL, generations INTEGER NOT NULL, failures INTEGER NOT NULL);');
 const empty=await readLighterLedger({DB:emptyDb} as Env);
 expect(empty).toEqual({available:true,rows:{}});
 const started=Date.parse('2026-11-17T13:00:00Z');
 await emptyDb.prepare('INSERT INTO lighter_stats VALUES(?,?,?,?,?,?,?)').bind('all',started,0,0,0,0,0).run();
 await emptyDb.prepare('INSERT INTO lighter_stats VALUES(?,?,?,?,?,?,?)').bind('es',started,4,1,3,2,1).run();
 await emptyDb.prepare('INSERT INTO lighter_stats VALUES(?,?,?,?,?,?,?)').bind('en',started,-1,0,0,0,0).run();
 const ledger=await readLighterLedger({DB:emptyDb} as Env);
 expect(ledger.available).toBe(true);
 if(!ledger.available)return;
 expect(ledger.rows.all).toEqual({startedAt:started,interactions:0,cacheHits:0,attempts:0,generations:0,failures:0});
 expect(ledger.rows.es?.interactions).toBe(4);
 expect(ledger.rows.en).toBeUndefined();
 const broken=await readLighterQueue({DB:{prepare(){throw new Error('no such table');}}} as unknown as Env,1);
 expect(broken).toEqual({available:false});
});

const view=(over:Partial<LighterView>={}):LighterView=>({
 ledger:{available:true,rows:{all:{startedAt:Date.parse('2026-11-17T13:00:00Z'),interactions:5,cacheHits:2,attempts:3,generations:2,failures:1},es:{startedAt:Date.parse('2026-11-17T13:00:00Z'),interactions:3,cacheHits:1,attempts:2,generations:1,failures:1}}},
 queue:{available:true,pending:{es:2,en:1},retry:{es:0,en:1},failed:{es:1,en:0},withheld:{es:0,en:0}},
 ready:{available:true,truncated:false,ready:{es:1,en:0},examples:[{lang:'es',title:'Traffic delays & more',text:'La agencia informa demoras & trámites.',url:'https://example.com/ready',storyId:7,source:'noticel'}]},
 ...over,
});

it('renders localized ledger, cache state, and story links without the old call budget',async()=>{
 for (const lang of ['es','en'] as const) {
  const html=await renderer.fetch(new Request('https://news.dev.pr/stats?lang='+lang),{items:[],translations:{},feeds:[],lighterView:view()}).text();
  expect(html).toContain('id="lighter-stats"');
  expect(html).toContain('max-width:390px');
  expect(html).toContain('--bg:#0e1311');
  const lighter=html.slice(html.indexOf('id="lighter-stats"'),html.indexOf('id="clics"'));
  expect(lighter).not.toContain('180');
  expect(lighter).not.toContain('15 minutes');
  expect(lighter).not.toContain('15 minutos');
  const clicks=html.slice(html.indexOf('id="clics"'));
  expect(lighter).toContain(lang==='es'?'Solicitudes del botón: 5':'Button requests: 5');
  expect(lighter).toContain(lang==='es'?'Aciertos de caché: 2':'Cache hits: 2');
  expect(lighter).toContain(lang==='es'?'Generaciones guardadas: 2':'Stored generations: 2');
  expect(lighter).toContain(lang==='es'?'Fallos: 1':'Failures: 1');
  expect(lighter).toContain(lang==='es'?'Inglés: no disponible.':'English: unavailable.');
  expect(clicks).not.toContain('Button requests');
  expect(clicks).not.toContain('Solicitudes del botón');
  if(lang==='es'){
   expect(lighter).toContain('Pendientes elegibles: español 2 · inglés 1');
   expect(lighter).toContain('Traffic delays &amp; more');
   expect(lighter).toContain('demoras &amp; trámites');
   expect(lighter).toContain('Versión más ligera generada por IA');
   expect(lighter).toContain('href="/click?url='+encodeURIComponent('https://example.com/ready')+'"');
   expect(lighter).toContain('href="/story?id=7&amp;lang=es"');
   expect(lighter).toContain('Listas para mostrar, texto válido del titular y extracto actuales: español 1 · inglés 0.');
  } else {
   expect(lighter).toContain('Eligible pending: Spanish 2 · English 1');
   expect(lighter).toContain('No stored take matches the current headline and excerpt in this edition.');
   expect(lighter).not.toContain('demoras');
  }
 }
});

it('does not print ledger or ready counts when the reads fail',async()=>{
 const html=await renderer.fetch(new Request('https://news.dev.pr/stats?lang=en'),{items:[],translations:{},feeds:[],totals:{clicks:9,startedAt:Date.parse('2026-11-01T00:00:00Z')}}).text();
 const lighter=html.slice(html.indexOf('id="lighter-stats"'),html.indexOf('id="clics"'));
 expect(lighter).toContain('does not substitute zeros');
 expect(lighter).not.toContain('Button requests:');
 expect(lighter).not.toContain('Eligible pending:');
 expect(lighter).not.toContain('Ready to show');
 expect(lighter).toContain('Failure categories are unavailable');
 expect(lighter).toContain('last success time are unavailable');
 expect(html).toContain('9 lifetime outbound clicks');
 const started=await renderer.fetch(new Request('https://news.dev.pr/stats?lang=es'),{items:[],translations:{},feeds:[],lighterView:view({ledger:{available:true,rows:{}},queue:{available:false},ready:{available:false}})}).text();
 const section=started.slice(started.indexOf('id="lighter-stats"'),started.indexOf('id="clics"'));
 expect(section).toContain('El conteo no ha empezado');
 expect(section).not.toContain('Solicitudes del botón:');
 expect(section).not.toContain('Pendientes elegibles:');
 expect(section).not.toContain('Listas para mostrar');
});

it('shows a recorded zero with its start date and leaves a missing edition unavailable',async()=>{
 const startedAt=Date.parse('2026-11-17T13:00:00Z');
 const html=await renderer.fetch(new Request('https://news.dev.pr/stats?lang=en'),{items:[],translations:{},feeds:[],lighterView:view({
  ledger:{available:true,rows:{all:{startedAt,interactions:0,cacheHits:0,attempts:0,generations:0,failures:0},es:{startedAt,interactions:2,cacheHits:2,attempts:4,generations:2,failures:1}}},
 })}).text();
 const lighter=html.slice(html.indexOf('id="lighter-stats"'),html.indexOf('id="clics"'));
 expect(lighter).toContain('Button requests: 0');
 expect(lighter).toContain('since');
 expect(lighter).toContain('2026');
 expect(lighter).toContain('English: unavailable.');
 expect(lighter).not.toContain('Counting has not started');
 expect(lighter).toContain('shown as recorded');
});

it('serves /stats counts from D1 without mixing them into outbound clicks',async()=>{
 const DB=database('CREATE TABLE lighter_stats(scope TEXT PRIMARY KEY, started_at INTEGER NOT NULL, interactions INTEGER NOT NULL, cache_hits INTEGER NOT NULL, attempts INTEGER NOT NULL, generations INTEGER NOT NULL, failures INTEGER NOT NULL);CREATE TABLE story_ids(id INTEGER PRIMARY KEY, url TEXT UNIQUE);');
 const item=story('https://example.com/ready','Traffic delays','The agency reports traffic delays.',Date.now());
 await insertArticle(DB,item,Date.now());
 await insertCache(DB,key(item,'es'),takeEs,1,0);
 await insertCache(DB,key(item,'en'),takeEn,1,0);
 await DB.prepare('INSERT INTO story_ids(id,url) VALUES(?,?)').bind(7,item.url).run();
 const started=Date.parse('2026-11-17T13:00:00Z');
 await DB.prepare('INSERT INTO lighter_stats VALUES(?,?,?,?,?,?,?)').bind('all',started,5,2,3,2,1).run();
 await DB.prepare('INSERT INTO lighter_stats VALUES(?,?,?,?,?,?,?)').bind('es',started,3,1,2,1,1).run();
 await DB.prepare('INSERT INTO lighter_stats VALUES(?,?,?,?,?,?,?)').bind('en',started,2,1,1,1,0).run();
 const env={DB} as unknown as Env;
 const es=await (await worker.fetch(new Request('https://news.dev.pr/stats?lang=es'),env)).text();
 const en=await (await worker.fetch(new Request('https://news.dev.pr/stats?lang=en'),env)).text();
 expect(es).toContain('Solicitudes del botón: 5');
 expect(es).toContain('Solicitudes del botón: 3');
 expect(en).toContain('Button requests: 2');
 expect(en).toContain('Failures: 0');
 expect(es).toContain('/story?id=7');
 expect(es).toContain('/click?url='+encodeURIComponent(item.url));
 expect(es).toContain('Listas para mostrar, texto válido del titular y extracto actuales: español 1 · inglés 1.');
 expect(en).toContain(takeEn);
 expect(es).not.toContain('lifetime outbound');
 const bare=database('',['migrations/0001_live.sql']);
 const failed=await (await worker.fetch(new Request('https://news.dev.pr/stats?lang=en'),{DB:bare} as unknown as Env)).text();
 const section=failed.slice(failed.indexOf('id="lighter-stats"'),failed.indexOf('id="clics"'));
 expect(section).toContain('does not substitute zeros');
 expect(section).not.toContain('Button requests:');
 expect(section).toContain('Ready takes are unavailable');
 expect(section).toContain('The queue state is unavailable');
});
