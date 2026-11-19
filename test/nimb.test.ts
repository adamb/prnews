import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {currentItem,repairNimbTitle} from '../src/current-item';
import {assertArticleFeed,feeds,refresh,retryDelay,type Env} from '../src/ingest';
import {sources} from '../src/sources';

it('repairs money and possessives only for manual NIMB headlines',()=>{
 expect(repairNimbTitle('Palmas Athletic Club UBS seek 46 4m consent judgment')).toBe('Palmas Athletic Club UBS seek $46.4m consent judgment');
 expect(repairNimbTitle('Puerto ricos new opportunity zone map shrinks by nearly 80')).toBe('Puerto Rico’s new opportunity zone map shrinks by nearly 80%');
 const item:any={url:'https://example.org/a',title:'Puerto ricos 46 4m',source:'endi',reason:'manual-import',titleOrigin:'url-slug',summary:'',section:'negocios'};
 expect(currentItem(item).title).toBe(item.title);
 expect(currentItem({...item,source:'nimb'}).title).toBe('Puerto Rico’s $46.4m');
 expect(repairNimbTitle('$46.4m')).toBe('$46.4m');
});

it('keeps News is my Business paused and does not register the robots.txt sitemap lines',()=>{
 expect(sources.filter(s=>s.id==='nimb')).toHaveLength(1);
 expect(sources.find(s=>s.id==='nimb')!.homepage).toBe('https://newsismybusiness.com');
 expect(feeds.nimb).toEqual([]);
 const registered=Object.values(feeds).flat();
 expect(registered).not.toContain('https://newsismybusiness.com/sitemap.xml');
 expect(registered).not.toContain('https://newsismybusiness.com/sitemap.rss');
 expect(registered).not.toContain('https://newsismybusiness.com/feed/');
 // Production feed_state on 2026-11-14 had failures=3 and a 2 hour next_check.
 expect(retryDelay(3)).toBe(7_200_000);
 expect(retryDelay(1)).toBe(1_800_000);
 expect(retryDelay(8)).toBe(4*3_600_000);
});

it('rejects a challenge page and a sitemap, and still accepts a headline feed',()=>{
 const challenge=readFileSync('test/fixtures/nimb-challenge.html','utf8');
 const sitemap=readFileSync('test/fixtures/nimb-sitemap-index.xml','utf8');
 const sitemapRss=readFileSync('test/fixtures/nimb-sitemap.rss.xml','utf8');
 expect(()=>assertArticleFeed(challenge,'nimb')).toThrow(/HTML page is not an article feed: nimb/);
 expect(()=>assertArticleFeed(sitemap,'nimb')).toThrow(/Sitemap is not an article feed: nimb/);
 expect(()=>assertArticleFeed(sitemapRss,'nimb')).toThrow(/Sitemap is not an article feed: nimb/);
 expect(()=>assertArticleFeed(readFileSync('test/fixtures/wipr.xml','utf8'),'wipr')).not.toThrow();
 expect(()=>assertArticleFeed(readFileSync('test/fixtures/radioisla.xml','utf8'),'radioisla')).not.toThrow();
});

function database(): D1Database {
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync('migrations/0001_live.sql','utf8'));
 sqlite.exec(readFileSync('migrations/0010_image_enrich.sql','utf8'));
 function prepare(sql:string):any {
  let args:any[]=[];
  return {bind(...values:any[]){args=values;return this;},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){const result=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};}};
 }
 return {prepare,async batch(statements:any[]){return Promise.all(statements.map(s=>s.run()));}} as unknown as D1Database;
}

afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

it('does not request the blocked host, keeps a manual import, and backs off an HTML challenge',async()=>{
 const DB=database(),env={DB} as Env;
 const now=Date.parse('2026-11-19T16:40:00Z');
 vi.spyOn(Date,'now').mockReturnValue(now);
 const manual={url:'https://newsismybusiness.com/manual-story/',source:'nimb',title:'Manual headline',summary:'Short excerpt.',image:'',time:now-3_600_000,observed:false,section:'negocios',reason:'manual-import'};
 const payload=JSON.stringify(manual);
 await DB.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)').bind(manual.url,'nimb',payload,now-86_400_000,now-86_400_000,manual.time).run();
 const calls:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(input:URL)=>{
  const url=input.toString();
  calls.push(url);
  if(url.startsWith('https://wipr.pr/feed/')) return new Response(readFileSync('test/fixtures/nimb-challenge.html','utf8'),{status:200,headers:{'content-type':'text/html'}});
  return new Response(null,{status:304});
 }));
 await refresh(env);
 expect(calls.some(url=>url.includes('newsismybusiness.com'))).toBe(false);
 const kept=await DB.prepare('SELECT payload FROM articles WHERE url=?').bind(manual.url).first<{payload:string}>();
 expect(kept?.payload).toBe(payload);
 expect((await DB.prepare("SELECT COUNT(*) AS n FROM articles WHERE source='nimb'").first<{n:number}>())?.n).toBe(1);
 expect((await DB.prepare("SELECT COUNT(*) AS n FROM articles WHERE source='wipr'").first<{n:number}>())?.n).toBe(0);
 const failure=await DB.prepare("SELECT status,error,failures,next_check,last_ok,item_count FROM feed_state WHERE source='wipr'").first<{status:number;error:string;failures:number;next_check:number;last_ok:number|null;item_count:number}>();
 expect(failure).toMatchObject({status:200,error:'HTML page is not an article feed: wipr',failures:1,next_check:now+retryDelay(1),last_ok:null,item_count:0});
 const before=calls.length;
 vi.spyOn(Date,'now').mockReturnValue(now+840_001);
 await refresh(env);
 expect(calls.slice(before).some(url=>url.startsWith('https://wipr.pr/feed/'))).toBe(false);
 expect(calls.some(url=>url.includes('newsismybusiness.com'))).toBe(false);
 expect((await DB.prepare('SELECT payload FROM articles WHERE url=?').bind(manual.url).first<{payload:string}>())?.payload).toBe(payload);
});
