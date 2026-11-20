import { DatabaseSync } from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import renderer from '../src/render';
import worker from '../src/index';
import {refresh, type Env} from '../src/ingest';
import {sampleQueue, queueHistory} from '../src/stats';
import {needsTranslation, type Translation} from '../src/i18n';
import {currentItem} from '../src/current-item';
import data from '../src/data.json';
import type {Item} from '../src/parse';

function database(): D1Database {
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync('migrations/0001_live.sql','utf8'));
 sqlite.exec(readFileSync('migrations/0007_queue_history.sql','utf8'));
 sqlite.exec('CREATE TABLE IF NOT EXISTS story_ids (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE)');
 function prepare(sql:string):any {
  let args:any[]=[];
  return {bind(...values:any[]){args=values;return this;},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){const result=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};}};
 }
 return {prepare,async batch(statements:any[]){return Promise.all(statements.map(s=>s.run()));}} as unknown as D1Database;
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

const spanish=(title:string,summary='El extracto completo de esta noticia local.'):Item =>
 ({url:`https://example.org/${title.replace(/\s+/g,'-').toLowerCase()}`,source:'noticel',title,summary,image:'',time:Date.now()-1000,observed:false,section:'politica',reason:'test'});
const validEntry=(item:Item):Translation=>({originalTitle:item.title,originalSummary:item.summary,title:'Clear English headline',summary:'A faithful English excerpt.'});
const copiedEntry=(item:Item):Translation=>({originalTitle:item.title,originalSummary:item.summary,title:item.title,summary:'Excerpt in English.'});

it('counts invalid cached translations, so /api/live and the stats queue agree (reproduces 31 vs 0)',async()=>{
 const valid=spanish('Titular traducido'),copied=spanish('Titular copiado sin traducir'),missing=spanish('Titular sin traducción'),english={...spanish('Original in English'),originalLanguage:'en' as const};
 const live={items:[valid,copied,missing,english],translations:{[valid.url]:validEntry(valid),[copied.url]:copiedEntry(copied)},feeds:[]};
 const home=await renderer.fetch(new Request('https://example.com/?lang=en'),live).text();
 const stats=await renderer.fetch(new Request('https://example.com/stats?lang=en'),live).text();
 expect(home).not.toContain('posts are awaiting English translation'); // counts live in /api/live and /stats, not on public pages
 expect(home).not.toContain('class="notice"');
 expect(stats).toContain('Translation queue: 2');
 // Truthful breakdown of the same number instead of a definition that hides invalid cached work.
 expect(stats).toContain('With no stored translation: 1. With a cached translation that failed validation: 1.');
 // Spanish edition is unaffected: it shows originals without a pending notice.
 const local=await renderer.fetch(new Request('https://example.com/'),live).text();
 expect(local).toContain('Titular copiado sin traducir');
 expect(local).not.toContain('awaiting English translation');
});

it('needsTranslation mirrors the English edition: stale or copied caches are pending, English originals and bundled snapshot entries are not',()=>{
 const item=spanish('Titular vigente');
 expect(needsTranslation(item,{[item.url]:validEntry(item)})).toBe(false);
 expect(needsTranslation(item,{[item.url]:copiedEntry(item)})).toBe(true);
 expect(needsTranslation(item,{})).toBe(true);
 expect(needsTranslation({...item,summary:'Resumen cambiado después de traducir'},{[item.url]:validEntry(item)})).toBe(true);
 expect(needsTranslation(item)).toBe(true);
 const bundled=(data.items as Item[]).map(currentItem).find(i=>i.source==='noticel')!;
 expect(bundled).toBeTruthy();
 expect(needsTranslation(bundled,{})).toBe(false); // covered by a bundled snapshot translation
 expect(needsTranslation({...bundled,summary:bundled.summary+' (actualizado)'},{})).toBe(true); // changed original → pending again
 expect(needsTranslation({...item,originalLanguage:'en' as const},{})).toBe(false);
 expect(needsTranslation({...item,source:'sjds'},{})).toBe(false);
});

it('sampleQueue records the shared definition alongside the scheduler, without touching older samples',async()=>{
 const DB=database(),env={DB} as unknown as Env;
 const now=Date.parse('2026-11-14T18:00:00Z');
 vi.spyOn(Date,'now').mockReturnValue(now);
 const insert=async(item:Item,translation:string|null,attempt:number,published=Date.now())=>
  DB.prepare('INSERT INTO articles(url,source,payload,translation,translation_attempt,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?,?,?)')
   .bind(item.url,item.source,JSON.stringify(item),translation,attempt,now,now,published).run();
 const valid=spanish('Titular válido'),invalid=spanish('Titular con caché inválida'),missing=spanish('Titular nunca traducido');
 await insert(valid,JSON.stringify(validEntry(valid)),0);
 await insert(invalid,JSON.stringify(copiedEntry(invalid)),0);
 await insert(missing,null,0);
 await insert({...spanish('Publicación inglesa importada'),originalLanguage:'en' as const},null,0);
 await insert({...spanish('San Juan Daily Star'),source:'sjds'},null,0);
 await insert(spanish('Titular fuera de ventana'),null,0,now-15*86400000);
 await DB.prepare('INSERT INTO translation_queue_history(sampled_at,pending) VALUES(?,?)').bind(now-30*60000,7).run();
 await sampleQueue(env);
 const history=await queueHistory(env);
 expect(history.map(h=>h.pending)).toEqual([7,2]); // old NULL-only sample kept as recorded, new sample uses the shared definition
 const last=await DB.prepare('SELECT pending FROM translation_queue_history ORDER BY sampled_at DESC LIMIT 1').first<any>();
 expect(last.pending).toBe(2);
 const stats=await worker.fetch(new Request('https://example.com/stats?lang=en'),env);
 expect(await stats.text()).toContain('Translation queue: 2');
 const payload:any=await (await worker.fetch(new Request('https://example.com/api/live?lang=en'),env)).json();
 expect(payload.pending).toBe(2); // the count lives in the live payload and /stats, not on public pages
 const home=await worker.fetch(new Request('https://example.com/?lang=en'),env);
 expect(await home.text()).not.toContain('posts are awaiting English translation');
});

function aiMock(translate:(entry:{id:number;source:string;title:string;summary:string})=>{title:string;summary:string}) {
 return {run:vi.fn(async(_model:string,options:any)=>{
  const payload=JSON.parse(options.messages[1].content) as {id:number;source:string;title:string;summary:string}[];
  return {response:{articles:payload.map(entry=>({id:entry.id,...translate(entry)}))}};
 })} as any;
}
async function refreshWithAI(env:Env,AI:any){vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:503})));return refresh({...env,AI});}

it('retries invalid cached translations and translates missing ones, without re-touching valid or backoff rows',async()=>{
 const DB=database(),env={DB} as unknown as Env;
 const now=Date.parse('2026-11-14T18:00:00Z');
 vi.spyOn(Date,'now').mockReturnValue(now);
 const insert=async(item:Item,translation:string|null,attempt=0)=>
  DB.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at,translation,translation_attempt) VALUES(?,?,?,?,?,?,?,?)')
   .bind(item.url,item.source,JSON.stringify(item),now-1000,now,item.time,translation,attempt).run();
 const staleCopy=spanish('Titular copiado inválido');
 const alreadyValid=spanish('Titular ya traducido');
 const backoff=spanish('Titular en reintento reciente');
 const neverTried=spanish('Titular nunca intentado');
 await insert(staleCopy,JSON.stringify(copiedEntry(staleCopy)));
 await insert(alreadyValid,JSON.stringify(validEntry(alreadyValid)));
 await insert(backoff,null,now-600000); // claimed 10 minutes ago; stays in hourly backoff
 await insert(neverTried,null,0);
 const AI=aiMock(entry=>({title:`English: ${entry.title}`,summary:entry.summary?'Faithful English excerpt.':''}));
 await refreshWithAI(env,AI);
 expect(AI.run).toHaveBeenCalledTimes(1); // one batch for exactly the two claimable rows
 const stored=async(item:Item)=>DB.prepare('SELECT translation,translation_attempt FROM articles WHERE url=?').bind(item.url).first<any>();
 const copied=await stored(staleCopy);
 expect(JSON.parse(copied.translation).title).toBe('English: Titular copiado inválido'); // invalid cache replaced
 expect(copied.translation_attempt).toBe(now); // claimed this run
 const tried=await stored(neverTried);
 expect(JSON.parse(tried.translation).title).toBe('English: Titular nunca intentado');
 expect(tried.translation_attempt).toBe(now);
 const untouched=await stored(alreadyValid);
 expect(untouched.translation).toBe(JSON.stringify(validEntry(alreadyValid))); // valid work neither redone nor claimed
 expect(untouched.translation_attempt).toBe(0);
 const waiting=await stored(backoff);
 expect(waiting.translation).toBeNull(); // still untranslated and still counted as pending
 expect(waiting.translation_attempt).toBe(now-600000); // not re-claimed inside the backoff window
});

it('keeps failing rows bounded: an invalid output does not crash the run and leaves the row for the next hourly retry',async()=>{
 const DB=database(),env={DB} as unknown as Env;
 const now=Date.parse('2026-11-14T18:00:00Z');
 vi.spyOn(Date,'now').mockReturnValue(now);
 const staleCopy=spanish('Titular reincidente');
 await DB.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at,translation,translation_attempt) VALUES(?,?,?,?,?,?,?,?)')
  .bind(staleCopy.url,staleCopy.source,JSON.stringify(staleCopy),now-1000,now,staleCopy.time,JSON.stringify(copiedEntry(staleCopy)),0).run();
 const AI=aiMock(entry=>({title:entry.title,summary:entry.summary})); // model copies the Spanish headline again
 await refreshWithAI(env,AI);
 const row=await DB.prepare('SELECT translation,translation_attempt FROM articles WHERE url=?').bind(staleCopy.url).first<any>();
 expect(JSON.parse(row.translation).title).toBe(staleCopy.title); // old invalid entry kept, not crash, not duplicated
 expect(row.translation_attempt).toBe(now); // bounded attempt pushed into the next retry window
});
