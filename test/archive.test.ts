import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {archiveImages,fetchImage,imageUrl,serveArchiveImage} from '../src/archive';
import type {Env} from '../src/ingest';
import worker from '../src/index';
function setup(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync('migrations/0001_live.sql','utf8'));sql.exec(readFileSync('migrations/0002_archive.sql','utf8'));sql.exec(readFileSync('migrations/0006_archive_queue_conflict.sql','utf8'));
 function prepare(text:string):any {let args:any[]=[];return {bind(...v:any[]){args=v;return this;},async first(){return sql.prepare(text).get(...args)??null;},async all(){return {results:sql.prepare(text).all(...args)};},async run(){return {meta:{changes:Number(sql.prepare(text).run(...args).changes)}};}};}
 const DB={prepare,async batch(s:any[]){return Promise.all(s.map(i=>i.run()));}} as unknown as D1Database;
 return {DB,sql};
}
const item={url:'https://example.com/story/',source:'noticel',title:'Original headline',summary:'Summary',image:'https://example.com/image.png',time:1794672000000,observed:false,section:'politica',reason:'keywords'};
afterEach(()=>vi.unstubAllGlobals());
it('retains revisions, translations, and image jobs independently of rolling retention',async()=>{
 const {DB,sql}=setup();
 sql.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)').run(item.url,item.source,JSON.stringify(item),item.time,item.time,item.time);
 const update=(payload:any)=>sql.prepare('UPDATE articles SET payload=?,updated_at=updated_at+1000 WHERE url=?').run(JSON.stringify(payload),item.url);
 update({...item,reason:'different metadata'});
 expect(sql.prepare('SELECT COUNT(*) AS n FROM archive_revisions').get()!.n).toBe(1);
 update({...item,title:'Changed headline'});update(item);
 expect(sql.prepare('SELECT COUNT(*) AS n FROM archive_revisions').get()!.n).toBe(3);
 const translation={originalTitle:item.title,originalSummary:item.summary,title:'English headline',summary:'English summary'};
 sql.prepare('UPDATE articles SET translation=? WHERE url=?').run(JSON.stringify(translation),item.url);
 expect(sql.prepare('SELECT COUNT(*) AS n FROM archive_revisions WHERE translation IS NOT NULL').get()!.n).toBe(2);
 sql.exec('DELETE FROM articles');
 expect(sql.prepare('SELECT COUNT(*) AS n FROM archive_revisions').get()!.n).toBe(3);
 expect(sql.prepare('SELECT COUNT(*) AS n FROM archive_images').get()!.n).toBe(1);
 const response=await worker.fetch(new Request('https://news.dev.pr/archive'),{DB});
 expect(response.status).toBe(200);const html=await response.text();expect(html).toContain('Changed headline');expect(html).toContain(' AST');
 expect((await worker.fetch(new Request('https://news.dev.pr/archive?date=bad'),{DB})).status).toBe(400);
});
it('stores identical image bytes once and never re-downloads saved URLs',async()=>{
 const {DB,sql}=setup();
 sql.exec("INSERT INTO archive_images(url) VALUES('https://example.com/a.png'),('https://example.com/b.png')");
 const bytes=Uint8Array.from([137,80,78,71,13,10,26,10,0]);
 const fetcher=vi.fn(async()=>new Response(bytes,{headers:{'Content-Type':'image/png'}}));vi.stubGlobal('fetch',fetcher);
 const stored=new Map<string,any>();
 const bucket={head:vi.fn(async(k:string)=>stored.get(k)??null),put:vi.fn(async(k:string,b:Uint8Array)=>{stored.set(k,b);})};
 const env={DB,ARCHIVE:bucket} as unknown as Env;
 await archiveImages(env);await archiveImages(env);
 expect(fetcher).toHaveBeenCalledTimes(2);expect(stored.size).toBe(1);
 const records=sql.prepare('SELECT * FROM archive_images').all();expect(records[0].object_key).toBe(records[1].object_key);expect(records[0].saved_at).toBeTruthy();
});
it('records image failures, caps retries, and rejects unsafe or unsupported downloads',async()=>{
 const {DB,sql}=setup();sql.exec("INSERT INTO archive_images(url) VALUES('https://example.com/a.svg')");
 vi.stubGlobal('fetch',async()=>new Response('<svg/>',{headers:{'Content-Type':'image/svg+xml'}}));
 await archiveImages({DB,ARCHIVE:{}} as Env);
 const row=sql.prepare('SELECT * FROM archive_images').get()!;expect(row.attempts).toBe(1);expect(row.object_key).toBeNull();expect(row.error).toBeTruthy();
 expect(()=>imageUrl('http://127.0.0.1/a')).toThrow();
 expect(()=>imageUrl('https://example.local/a')).toThrow();
 await expect(fetchImage('https://example.com/a.svg')).rejects.toThrow('unsupported');
 expect((await serveArchiveImage(new Request('https://news.dev.pr/archive/images/invalid'),{DB})).status).toBe(404);
});

it('article upserts sharing image URLs do not abort ingestion',()=>{
 const {sql}=setup();
 const query=sql.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET payload=excluded.payload');
 for(const title of ['First','Second'])query.run(item.url,item.source,JSON.stringify({...item,title}),item.time,item.time,item.time);
 query.run(item.url+'other',item.source,JSON.stringify({...item,url:item.url+'other'}),item.time,item.time,item.time);
 expect(sql.prepare('SELECT COUNT(*) AS n FROM articles').get()!.n).toBe(2);
 expect(sql.prepare('SELECT COUNT(*) AS n FROM archive_images').get()!.n).toBe(1);
});
