import { DatabaseSync } from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import worker, { serveBounded } from '../src/index';
import { noticeText } from '../src/render';
import type {Env} from '../src/ingest';
import type {Item} from '../src/parse';
import type {Translation} from '../src/i18n';

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

/** One valid translation, one cached-but-invalid, one missing, one English original, one feed row. */
async function seededEnv(){
 const DB=database(),now=Date.now();
 const insert=async(item:Item,translation:string|null)=>
  DB.prepare('INSERT INTO articles(url,source,payload,translation,translation_attempt,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?,?,?)')
   .bind(item.url,item.source,JSON.stringify(item),translation,0,now,now,item.time).run();
 const valid=spanish('Titular traducido'),copied=spanish('Titular copiado sin traducir'),missing=spanish('Titular sin traducción'),english={...spanish('Original in English'),originalLanguage:'en' as const};
 await insert(valid,JSON.stringify(validEntry(valid)));
 await insert(copied,JSON.stringify(copiedEntry(copied)));
 await insert(missing,null);
 await insert(english,null);
 await DB.prepare('INSERT INTO feed_state(url,source,last_ok) VALUES(?,?,?)').bind('https://example.org/feeds/noticel','noticel',Date.now()-60000).run();
 return {DB,env:{DB} as unknown as Env};
}

it('/api/live agrees with the rendered stats page: payload counts and the stats queue share one truth (reproduces the stale-banner contradiction class)',async()=>{
 const {env}=await seededEnv();
 const stats=await worker.fetch(new Request('https://example.com/stats?lang=en'),env);
 expect(stats.headers.get('Cache-Control')).toBe('public, max-age=60'); // HTML never invites hour-long browser caching
 const html=await stats.text();
 const queue=Number(html.match(/Translation queue: (\d+)/)![1]);
 const live=await worker.fetch(new Request('https://example.com/api/live?lang=en'),env);
 expect(live.headers.get('Cache-Control')).toBe('no-store'); // freshness source is never cacheable
 const payload:any=await live.json();
 expect(payload.pending).toBe(queue);
 expect(payload.none).toBe(1);
 expect(payload.invalid).toBe(1);
 expect(payload.notice.en).toContain(`${payload.pending} posts are awaiting English translation.`);
 expect(payload.notice.en).toContain('Last successful check:');
 expect(payload.detail.en).toContain('With no stored translation: 1. With a cached translation that failed validation: 1.');
 expect(payload.lastOk).toBeGreaterThan(0);
});

it('no public page carries the technical banner; the live hook still refreshes the stats page and stays null-safe without it',async()=>{
 const {env}=await seededEnv();
 const stats=await (await worker.fetch(new Request('https://example.com/stats?lang=en'),env)).text();
 expect(stats).not.toContain('<div class="notice"');
 expect(stats).toContain('data-live="queue"');
 expect(stats).toContain('data-live="detail"');
 expect(stats).toContain("fetch('/api/live?lang='+lang,{cache:'reload'})");
 // No public page carries the feed-check/translation-pending banner, with or without live data.
 for(const path of ['/?lang=en','/s/politica?lang=en','/search?lang=en','/about?lang=en','/fuentes?lang=en','/signup?lang=en','/archive?lang=en'])
  expect(await (await worker.fetch(new Request('https://example.com'+path),env)).text(),path).not.toContain('<div class="notice"');
 expect(await (await worker.fetch(new Request('https://example.com/'),env)).text()).not.toContain('<div class="notice"');
});

it('the same single number holds on the Spanish stats page: payload matches the rendered queue',async()=>{
 const {env}=await seededEnv();
 const html=await (await worker.fetch(new Request('https://example.com/stats?lang=es'),env)).text();
 const queue=Number(html.match(/Cola de traducción: (\d+)/)![1]);
 const payload:any=await (await worker.fetch(new Request('https://example.com/api/live?lang=es'),env)).json();
 expect(payload.pending).toBe(queue);
 expect(payload.notice.es).toContain('Última consulta exitosa:');
 expect(payload.notice.es).not.toContain('posts are awaiting');
});

it('when the queue drains, the payload goes to zero and the wording drops the awaiting sentence',async()=>{
 const DB=database(),now=Date.now();
 const item=spanish('Titular ya traducido');
 const entry=validEntry(item);
 await DB.prepare('INSERT INTO articles(url,source,payload,translation,translation_attempt,first_seen,updated_at,published_at) VALUES(?,?,?,?,0,?,?,?)')
  .bind(item.url,item.source,JSON.stringify(item),JSON.stringify(entry),now,now,item.time).run();
 const env:{DB:D1Database}={DB};
 const html=await (await worker.fetch(new Request('https://example.com/stats?lang=en'),env as unknown as Env)).text();
 expect(html).not.toContain('<span data-live="detail">'); // fresh render omits the breakdown at zero
 const payload:any=await (await worker.fetch(new Request('https://example.com/api/live?lang=en'),env as unknown as Env)).json();
 expect(payload.pending).toBe(0);
 expect(payload.notice.en).not.toContain('posts are awaiting'); // so the refresh swap cannot leave a stale count behind
});

it('noticeText keeps its wording contract: feed recency, pending suffix only when nonzero',()=>{
 const ts=Date.parse('2026-11-14T21:45:00-04:00');
 expect(noticeText('en',[{last_ok:ts}],0)).toBe('Automatic updates. Last successful check: 11/14/26, 9:45 PM AST Headlines and excerpts are machine-translated; links open the original reporting.');
 expect(noticeText('en',[{last_ok:ts}],3)).toBe('Automatic updates. Last successful check: 11/14/26, 9:45 PM AST Headlines and excerpts are machine-translated; links open the original reporting. 3 posts are awaiting English translation.');
 expect(noticeText('en',[],0)).toContain('Automatic updates. Last successful check: pending');
 expect(noticeText('es',[{last_ok:ts}],5)).toContain('Última consulta exitosa: 11/14/26, 9:45 p. m. AST');
 expect(noticeText('es',[{last_ok:ts}],5)).not.toContain('posts are awaiting'); // count sentence stays English-only
});

it('stored cache responses are served with the origin freshness, never the platform 4h stamp (demonstrated root cause regression)',async()=>{
 const stored=new Response('<html>stale</html>',{headers:{'Cache-Control':'public, max-age=14400','Age':'120','Last-Modified':'Sun, 15 Nov 2026 01:47:36 GMT','Content-Length':'15'}});
 const served=serveBounded(stored);
 expect(served.headers.get('Cache-Control')).toBe('public, max-age=60'); // browser may hold the page at most 60s
 expect(served.headers.get('Content-Length')).toBeNull(); // reframed body must not keep the old length
 expect(served.status).toBe(200);
 expect(await served.text()).toBe('<html>stale</html>');
});
