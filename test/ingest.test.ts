import { DatabaseSync } from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {refresh, feeds, type Env} from '../src/ingest';
import {sources} from '../src/sources';
import worker from '../src/index';
function database(): D1Database {
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync('migrations/0001_live.sql','utf8'));
 sqlite.exec(readFileSync('migrations/0004_digest.sql','utf8'));
 sqlite.exec(readFileSync('migrations/0010_image_enrich.sql','utf8'));
 sqlite.exec('CREATE TABLE IF NOT EXISTS story_ids (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE)');
 function prepare(sql:string):any {
  let args:any[]=[];
  return {bind(...values:any[]){args=values;return this;},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){const result=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};}};
 }
 return {prepare,async batch(statements:any[]){return Promise.all(statements.map(s=>s.run()));}} as unknown as D1Database;
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
const FEED_HOSTS=['noticel.com','elnuevodia.com','primerahora.com','metro.pr','telemundopr.com','periodicolaperla.com','sanjuandailystar.com','wapa.tv','wipr.pr','claridadpuertorico.com','radioisla.tv','waloradio.com','news.pr','elvocero.com','reddit.com','arctic-shift','periodicovision.com','lacallerevista.com','periodicoelsolpr.com','esnoticiapr.com','periodicoeloriental.com','laesquina.com','9millones.com','eyboricua.com','pasquines.us','wkaq580.com','presenciapr.com'];
const isFeedRequest=(url:string)=>url.startsWith('https://www.reddit.com/')||FEED_HOSTS.some(h=>url.includes(h));
it('scans all feeds, preserves first-seen times, handles 304 and isolates failures',async()=>{
 const DB=database(),env={DB} as Env;
 const now=Date.parse('2026-11-14T12:00:00Z');
 vi.spyOn(Date,'now').mockReturnValue(now);
 const requests:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(input:URL)=>{
  const url=input.toString();requests.push(url);
  const source=sources.find(s=>feeds[s.id].some(f=>url.startsWith(f)))!;
  if(source.id==='metro')return new Response('',{status:500});
  const file=source.id==='noticel'&&url.includes('paged=2')?source.files[1]:(source.files[0] ?? 'sjds_blogfeed.xml');
  return new Response(readFileSync('test/fixtures/'+file,'utf8').replaceAll(source.id === 'nimb' ? 'www.sanjuandailystar.com' : '__unused__', 'newsismybusiness.com'),{headers:{etag:'"v1"'}});
 }));
 await refresh(env);
 expect(isFeedRequest(requests[0].toString()));
 const feedURLs=new Set(Object.values(feeds).flat());
 expect(requests.filter(u=>[...feedURLs].some(f=>f===u||u.startsWith(f))).length).toBe(27); // every configured feed URL, including NotiCel page 2 and the 11 outlets added 2026-11-20; enrichment adds only article-page fetches
 expect(requests.some(r=>r.includes('_refresh='))).toBe(true);
 const first=await DB.prepare("SELECT payload FROM articles WHERE source='telemundo' LIMIT 1").first<{payload:string}>();
 expect(first).toBeTruthy();
 const failure=await DB.prepare("SELECT failures,error,next_check FROM feed_state WHERE source='metro'").first<any>();
 expect(failure.failures).toBe(1);expect(failure.error).toBe('HTTP 500');expect(failure.next_check).toBeGreaterThan(now+900000);
 // The public "why it matters" hero block was removed from story-card rendering,
 // so ingestion no longer generates or stores importance for the homepage hero.
 expect((await DB.prepare('SELECT COUNT(*) AS n FROM article_importance').first<any>()).n).toBe(0);
 const count=(await DB.prepare('SELECT COUNT(*) AS n FROM articles').first<any>()).n;
 vi.spyOn(Date,'now').mockReturnValue(now+900001);
 const conditional=vi.fn(async()=>new Response(null,{status:304}));vi.stubGlobal('fetch',conditional);
 await refresh(env);
 const calls=conditional.mock.calls as unknown as [URL, any?][];
 expect(calls.filter(([,options])=>options?.headers?.['If-None-Match']==='"v1"').length).toBe(24); // reddit and elvocero wait longer than 15 minutes; metro failed; the 11 outlets added 2026-11-20 are all due
 // Bounded image enrichment continues with still-ready queue rows (first run handled 12).
 const nonFeeds=calls.filter(([u])=>![...feedURLs].some(f=>String(u)===f||String(u).startsWith(f)));
 expect(nonFeeds.length).toBeGreaterThanOrEqual(1);expect(nonFeeds.length).toBeLessThanOrEqual(12);
 expect((await DB.prepare('SELECT COUNT(*) AS n FROM articles').first<any>()).n).toBe(count);
 expect((await DB.prepare("SELECT payload FROM articles WHERE source='telemundo' LIMIT 1").first<any>()).payload).toBe(first!.payload);
 const response=await worker.fetch(new Request('https://example.com/?lang=en'),env);
 expect(response.status).toBe(200);expect(await response.text()).not.toContain('class="notice"'); // banner removed; feed status stays in /api/live and /stats
});
it('rejects unauthenticated refresh requests and skips overlapping jobs',async()=>{
 const DB=database(),env={DB,REFRESH_TOKEN:'test-secret'};
 expect((await worker.fetch(new Request('https://example.com/internal/refresh',{method:'POST'}),env)).status).toBe(404);
 await DB.prepare("INSERT INTO jobs VALUES('refresh',?,'another-run')").bind(Date.now()+60000).run();
 expect(await refresh(env)).toEqual({skipped:'already running'});
});
it('updates changed articles, clears their translations, and does not reset observed dates',async()=>{
 const DB=database(), env={DB};
 const now=Date.parse('2026-11-14T12:00:00Z');vi.spyOn(Date,'now').mockReturnValue(now);
 const source=sources.find(s=>s.id==='telemundo')!;
 const xml=readFileSync('test/fixtures/telemundo.xml','utf8');
 vi.stubGlobal('fetch',async(input:URL)=>new Response(input.hostname==='www.telemundopr.com'?xml:'broken'));
 await refresh(env);
 const row=await DB.prepare("SELECT url,payload FROM articles WHERE source='telemundo' LIMIT 1").first<any>();
 await DB.prepare('UPDATE articles SET translation=? WHERE url=?').bind('{"title":"Old English"}',row.url).run();
 const old=JSON.parse(row.payload);
 vi.spyOn(Date,'now').mockReturnValue(now+900001);
 vi.stubGlobal('fetch',async(input:URL)=>new Response(input.hostname==='www.telemundopr.com'?xml.replace(old.title,old.title+' actualizado'):'broken'));
 await refresh(env);
 const changed=await DB.prepare('SELECT payload,translation FROM articles WHERE url=?').bind(row.url).first<any>();
 expect(JSON.parse(changed.payload).time).toBe(old.time);
 expect(JSON.parse(changed.payload).title).toBe(old.title+' actualizado');
 expect(changed.translation).toBeNull();
});
it('uses Arctic Shift when Reddit RSS fails and deduplicates when RSS recovers',async()=>{
 const DB=database(),env={DB};
 const now=Date.parse('2026-11-14T18:00:00Z');vi.spyOn(Date,'now').mockReturnValue(now);
 const {arcticFeed}=await import('../src/reddit');
 const {parseFeed}=await import('../src/parse');
 const source=sources.find(s=>s.id==='reddit_puertorico')!;
 const xml=readFileSync('test/fixtures/reddit_puertorico.xml','utf8');
 const item=parseFeed(xml,source,now)[0];
 const permalink=new URL(item.url).pathname;
 const post={id:permalink.split('/')[4],subreddit:'PuertoRico',permalink,title:item.title,created_utc:item.time/1000};
 const fetcher=vi.fn(async(input:URL)=>{
  if(input.toString()===arcticFeed)return Response.json({data:[post]});
  return new Response('',{status:429});
 });vi.stubGlobal('fetch',fetcher);
 await refresh(env);
 const saved=await DB.prepare('SELECT payload FROM articles WHERE url=?').bind(item.url).first<any>();
 expect(saved).toBeTruthy();
 expect((await DB.prepare('SELECT item_count FROM feed_state WHERE url=?').bind(arcticFeed).first<any>()).item_count).toBe(1);
 vi.spyOn(Date,'now').mockReturnValue(now+3600001);
 vi.stubGlobal('fetch',async(input:URL)=>input.hostname==='www.reddit.com'?new Response(xml):new Response('',{status:429}));
 await refresh(env);
 expect((await DB.prepare('SELECT COUNT(*) AS n FROM articles WHERE url=?').bind(item.url).first<any>()).n).toBe(1);
 await DB.prepare('UPDATE feed_state SET etag=?, modified=? WHERE url=?').bind('W/"stale-arctic"', 'Wed, 18 Nov 2026 21:15:14 GMT', arcticFeed).run();
 vi.spyOn(Date,'now').mockReturnValue(now+7200002);
 const arcticCalls: {url: string; headers?: Record<string, string>}[] = [];
 vi.stubGlobal('fetch', async (input: URL, init?: RequestInit) => {
  const url = input.toString();
  arcticCalls.push({url, headers: init?.headers as Record<string, string> | undefined});
  if (url === arcticFeed) return Response.json({data: [post]}, {headers: {etag: 'W/"fresh"'}});
  return new Response('', {status: 429});
 });
 await refresh(env);
 const arctic = arcticCalls.find(call => call.url === arcticFeed);
 expect(arctic?.headers?.['If-None-Match']).toBeUndefined();
 expect(arctic?.headers?.['If-Modified-Since']).toBeUndefined();
 expect((await DB.prepare('SELECT etag, modified FROM feed_state WHERE url=?').bind(arcticFeed).first<any>())).toEqual({etag: null, modified: null});
});
it.each(['wrapped','array'])('saves valid translation peers from %s responses when another headline is unchanged',async(shape)=>{
 const DB=database(),now=Date.now();
 const items=[{url:'https://example.org/a',source:'endi',title:'Noticia en español',summary:'El informe de hoy.',image:'',time:now-1000,observed:false,section:'otras',reason:'test'},{url:'https://example.org/b',source:'endi',title:'Otra noticia',summary:'Una noticia nueva.',image:'',time:now-2000,observed:false,section:'otras',reason:'test'}];
 for(const i of items)await DB.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)').bind(i.url,i.source,JSON.stringify(i),now,now,i.time).run();
 vi.stubGlobal('fetch',async()=>new Response('',{status:503}));
 const articles=[{id:0,title:items[0].title,summary:'Today’s report.'},{id:1,title:'Another story',summary:'A new story.'}];
 let importancePrompts=0;
 const AI={run:async(_model:unknown,options?:{messages?:unknown})=>{if(JSON.stringify(options?.messages??[]).includes('best explains'))importancePrompts++;return {response:shape==='array'?articles:{articles}};}};
 await refresh({DB,AI:AI as any});
 expect((await DB.prepare('SELECT translation FROM articles WHERE url=?').bind(items[0].url).first<any>()).translation).toBeNull();
 expect(JSON.parse((await DB.prepare('SELECT translation FROM articles WHERE url=?').bind(items[1].url).first<any>()).translation).title).toBe('Another story');
 // Translation stays the only AI work per refresh: no importance generations are spent
 // on hero excerpts (original or translated), and the table keeps no new rows.
 expect(importancePrompts).toBe(0);
 expect((await DB.prepare('SELECT COUNT(*) AS n FROM article_importance').first<any>()).n).toBe(0);
});

it('does not republish retained undated items older than fourteen days',async()=>{
 const DB=database(), now=Date.parse('2026-11-22T12:00:00Z');
 vi.spyOn(Date,'now').mockReturnValue(now);
 const url='https://www.telemundopr.com/noticias/old-undated/';
 const old={url,source:'telemundo',title:'Noticia antigua',summary:'Resumen',image:'',time:now-30*86400000,observed:true,section:'otras',reason:'test'};
 await DB.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)').bind(url,old.source,JSON.stringify(old),old.time,old.time,old.time).run();
 const xml='<rss version="2.0"><channel><item><title>Noticia antigua</title><link>'+url+'</link><description>Resumen</description></item></channel></rss>';
 vi.stubGlobal('fetch',async(input:URL)=>input.hostname==='www.telemundopr.com'?new Response(xml):new Response(null,{status:304}));
 await refresh({DB});
 const row=await DB.prepare('SELECT payload,published_at,first_seen FROM articles WHERE url=?').bind(url).first<any>();
 expect(row.published_at).toBe(old.time);
 expect(JSON.parse(row.payload).time).toBe(old.time);
 expect(row.first_seen).toBe(old.time);
});
