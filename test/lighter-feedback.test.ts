import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {expect, it, vi} from 'vitest';
import worker from '../src/index';
import renderer from '../src/render';
import {key, lighterClientScript} from '../src/lighter';
import {FEEDBACK_MIN_SAMPLE, FEEDBACK_RATE_PER_MINUTE, lighterFeedbackClientScript, lighterFeedbackRoute, readLighterFeedback} from '../src/lighter-feedback';
import {attachStoryIds} from '../src/lighter-stats';
import type {Env} from '../src/ingest';
import type {Item} from '../src/parse';

const takeEn='The agency reports delays on the roads.';
const takeEs='La agencia informa demoras en las carreteras.';
const story=(url:string, title:string, summary:string, published=1):Item=>({url, source:'noticel', title, summary, image:'', time:published, observed:false, section:'politica', reason:'test'});
const item=story('https://example.com/a','Traffic delays','The agency reports traffic delays.');
const token=(n:number)=>`${String(n).padStart(8,'0')}-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hashOf=async(value:string)=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('prnews-lighter-vote:'+value))).toString('hex');
const takeHashOf=async(text:string)=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('prnews-lighter-take:'+text))).toString('hex');

function database(files=['migrations/0001_live.sql','migrations/0011_lighter.sql','migrations/0012_lighter_stats.sql','migrations/0015_lighter_reason.sql','migrations/0016_lighter_votes.sql'],extra=''): D1Database {
 const sqlite=new DatabaseSync(':memory:');
 for (const file of files) sqlite.exec(readFileSync(file,'utf8'));
 if(extra)sqlite.exec(extra);
 sqlite.exec('CREATE TABLE IF NOT EXISTS story_ids (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE)');
 const prepare=(query:string)=>{
  let args:any[]=[];
  return {bind(...values:any[]){args=values;return this;},async first(){return sqlite.prepare(query).get(...args)??null;},async all(){return {results:sqlite.prepare(query).all(...args)};},async run(){const result=sqlite.prepare(query).run(...args);return {meta:{changes:Number(result.changes)}};}};
 };
 return {prepare, async batch(statements:Array<{run:()=>Promise<unknown>}>){return Promise.all(statements.map(s=>s.run()));}} as unknown as D1Database;
}
const seedTake=async(db:D1Database,it:Item,lang:'es'|'en',text:string)=>db.prepare('INSERT INTO lighter_cache(key,text,attempts,next_try) VALUES(?,?,1,0)').bind(key(it,lang),text).run();
const seedArticle=async(db:D1Database,it:Item,published=Date.now())=>db.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)').bind(it.url,it.source,JSON.stringify(it),published,published,published).run();
const voteRows=async(db:D1Database)=>(await db.prepare('SELECT token_hash, cache_key, take_hash, vote, voted_at FROM lighter_votes ORDER BY cache_key, vote').all<{token_hash:string;cache_key:string;take_hash:string;vote:string;voted_at:number}>()).results;

function route(env:Env,body:unknown,now:number,headers:Record<string,string>={}){
 return lighterFeedbackRoute(new Request('https://news.dev.pr/api/lighter-vote',{method:'POST',headers:{Origin:'https://news.dev.pr','Content-Type':'application/json','X-PRNews-Action':'lighter-vote','Sec-Fetch-Site':'same-origin',...headers},body:typeof body==='string'?body:JSON.stringify(body)}),env,now) as Promise<Response>;
}
async function workerPost(env:Env,body:unknown,headers:Record<string,string>={}){
 return worker.fetch(new Request('https://news.dev.pr/api/lighter-vote',{method:'POST',headers:{Origin:'https://news.dev.pr','Content-Type':'application/json','X-PRNews-Action':'lighter-vote','Sec-Fetch-Site':'same-origin',...headers},body:JSON.stringify(body)}),env);
}

it('refuses GET, other origins, foreign actions, and invalid bodies without a write or an AI call',async()=>{
 const DB=database();
 await seedArticle(DB,item);
 await seedTake(DB,item,'en',takeEn);
 const run=vi.fn();
 const env={DB,AI:{run}} as unknown as Env;
 const now=Date.UTC(2026,10,20,12,0,0);
 // GET and HEAD never write: the route answers method before anything else.
 expect(await (await worker.fetch(new Request('https://news.dev.pr/api/lighter-vote'),env)).json()).toEqual({status:'method'});
 expect((await worker.fetch(new Request('https://news.dev.pr/api/lighter-vote',{method:'HEAD'}),env)).status).toBe(405);
 expect((await DB.prepare('SELECT COUNT(*) AS n FROM lighter_votes').first<{n:number}>())!.n).toBe(0);
 expect((await DB.prepare('SELECT COUNT(*) AS n FROM lighter_vote_rate').first<{n:number}>())!.n).toBe(0);
 // Cross-origin, foreign action, and cross-site fetches are refused closed.
 for (const headers of [{'Origin':'https://evil.example'},{'X-PRNews-Action':'lighter'},{'Sec-Fetch-Site':'cross-site'}] as Record<string,string>[])
  expect(await route(env,{url:item.url,lang:'en',vote:'up',token:token(1)},now,headers)).toMatchObject({status:403});
 expect(await route(env,'not json',now)).toMatchObject({status:400});
 expect(await route(env,'x'.repeat(1001),now)).toMatchObject({status:400});
 for (const body of [
  {url:item.url,lang:'en',vote:'sideways',token:token(1),take:await takeHashOf(takeEn)},
  {url:item.url,lang:'fr',vote:'up',token:token(1),take:await takeHashOf(takeEn)},
  {url:item.url,lang:'en',vote:'up',token:'not-a-uuid',take:await takeHashOf(takeEn)},
  {url:'http://example.com/a',lang:'en',vote:'up',token:token(1),take:await takeHashOf(takeEn)},
  {url:item.url,lang:'en',token:token(1),take:await takeHashOf(takeEn)},
  {lang:'en',vote:'up',token:token(1),take:await takeHashOf(takeEn)},
  {url:item.url,lang:'en',vote:'up',token:token(1)},
  {url:item.url,lang:'en',vote:'up',token:token(1),take:'not-a-hash'},
  {url:item.url,lang:'en',vote:'up',token:token(1),take:'xyz'},
 ]) expect(await route(env,body,now)).toMatchObject({status:400});
 expect(await route(env,{url:'https://example.com/missing',lang:'en',vote:'up',token:token(1),take:await takeHashOf(takeEn)},now)).toMatchObject({status:404});
 expect(await voteRows(DB)).toHaveLength(0);
 expect(run).not.toHaveBeenCalled();
});

it('stores one current vote per browser per take, idempotent, changeable, and retractable',async()=>{
 const DB=database();
 await seedArticle(DB,item);
 await seedTake(DB,item,'en',takeEn);
 const env={DB} as unknown as Env;
 const now=Date.UTC(2026,10,20,12,0,0);
 const shown=await takeHashOf(takeEn);
 const cast=(vote:'up'|'down'|'none',n:number)=>route(env,{url:item.url,lang:'en',vote,token:token(n),take:shown},now);
 const first=await cast('up',1);
 expect(first.status).toBe(200);
 expect(await first.json()).toEqual({status:'ok',vote:'up'});
 expect(first.headers.get('Cache-Control')).toBe('no-store');
 // The raw token never lands in D1: only its domain-separated SHA-256 hash does.
 let rows=await voteRows(DB);
 expect(rows).toHaveLength(1);
 expect(rows[0].token_hash).toBe(await hashOf(token(1)));
 expect(rows[0].token_hash).not.toBe(token(1));
 expect(rows[0].cache_key).toBe(key(item,'en'));
 expect(rows[0].take_hash).toBe(shown);
 expect(rows[0].voted_at).toBe(now);
 // Replay is idempotent: the same vote again adds no row and no count.
 for(let i=0;i<3;i++)expect((await cast('up',1)).status).toBe(200);
 expect(await voteRows(DB)).toHaveLength(1);
 let view=await readLighterFeedback(env);
 expect(view).toMatchObject({available:true,up:1,down:0,ratedTakes:1,minSample:FEEDBACK_MIN_SAMPLE,top:[],bottom:[]});
 // A second browser is a second row on the same take.
 expect((await cast('down',2)).status).toBe(200);
 view=await readLighterFeedback(env);
 expect(view).toMatchObject({up:1,down:1,ratedTakes:1});
 // Change moves the same row; retract deletes exactly this browser's row.
 expect((await cast('down',1)).status).toBe(200);
 const firstHash=await hashOf(token(1));
 const mine=(await voteRows(DB)).find(row=>row.token_hash===firstHash)!;
 expect(mine.vote).toBe('down');
 view=await readLighterFeedback(env);
 expect(view).toMatchObject({up:0,down:2});
 expect((await cast('none',1)).status).toBe(200);
 expect((await cast('none',1)).status).toBe(200);
 view=await readLighterFeedback(env);
 expect(view).toMatchObject({up:0,down:1,ratedTakes:1});
 expect(await voteRows(DB)).toHaveLength(1);
 // Totals are derived counts over rows, so they can never go negative.
 expect((await cast('none',2)).status).toBe(200);
 view=await readLighterFeedback(env);
 expect(view).toMatchObject({up:0,down:0,ratedTakes:0});
 // Votes never touch the generation ledger or the daily model budget: the seeded
 // scopes stay at zero and no day row is ever created.
 const ledger=await DB.prepare('SELECT scope, interactions, attempts, generations FROM lighter_stats ORDER BY scope').all<{scope:string;interactions:number;attempts:number;generations:number}>();
 expect(ledger.results.map(row=>[row.interactions,row.attempts,row.generations])).toEqual([[0,0,0],[0,0,0],[0,0,0]]);
 expect((await DB.prepare('SELECT COUNT(*) AS n FROM lighter_budget').first<{n:number}>())!.n).toBe(0);
});

it('rejects votes for anything but the current displayed generation',async()=>{
 const DB=database();
 await seedArticle(DB,item);
 const env={DB} as unknown as Env;
 const now=Date.UTC(2026,10,20,12,0,0);
 const shown=await takeHashOf(takeEn);
 // No cache row at all.
 let answer=await route(env,{url:item.url,lang:'en',vote:'up',token:token(1),take:shown},now);
 expect(answer.status).toBe(409);
 expect(await answer.json()).toEqual({status:'gone'});
 // A hidden text (clearly the other edition for this key) is not a votable take.
 await seedTake(DB,item,'en',takeEs);
 answer=await route(env,{url:item.url,lang:'en',vote:'up',token:token(1),take:await takeHashOf(takeEs)},now);
 expect(answer.status).toBe(409);
 // A valid take is votable, but a changed headline is a different generation.
 await DB.prepare('UPDATE lighter_cache SET text=? WHERE key=?').bind(takeEn,key(item,'en')).run();
 expect((await route(env,{url:item.url,lang:'en',vote:'up',token:token(1),take:shown},now)).status).toBe(200);
 const changed={...item,title:'Traffic delays stretch for miles',summary:'The agency reports traffic delays for miles.'};
 await DB.prepare('UPDATE articles SET payload=? WHERE url=?').bind(JSON.stringify(changed),item.url).run();
 expect((await route(env,{url:item.url,lang:'en',vote:'down',token:token(1),take:shown},now)).status).toBe(409);
 // The new generation has no text yet, so it inherits no rating and accepts no vote.
 expect((await route(env,{url:item.url,lang:'en',vote:'up',token:token(2),take:shown},now)).status).toBe(409);
 expect(await voteRows(DB)).toHaveLength(1);
});

it('binds votes to the exact displayed text and rejects stale clients on a regenerated take',async()=>{
 const DB=database();
 await seedArticle(DB,item);
 const env={DB} as unknown as Env;
 const now=Date.UTC(2026,10,20,12,0,0);
 const textA='The agency reports delays on the roads, version one.';
 const textB='The agency reports delays on the roads, version two.';
 // A clearly-wrong-edition line is cleared and the same key can hold a new text:
 // the cache key alone does not identify the displayed generation.
 await seedTake(DB,item,'en',textA);
 const hashA=await takeHashOf(textA), hashB=await takeHashOf(textB);
 // Three browsers vote on the exact text A.
 for(const n of [1,5,6]) expect((await route(env,{url:item.url,lang:'en',vote:'up',token:token(n),take:hashA},now)).status).toBe(200);
 // The same key is regenerated with a different text B.
 await DB.prepare('UPDATE lighter_cache SET text=? WHERE key=?').bind(textB,key(item,'en')).run();
 // A stale client still showing A cannot vote, retract, or silently rate B.
 for(const vote of ['up','down','none'] as const) {
  const stale=await route(env,{url:item.url,lang:'en',vote,token:token(1),take:hashA},now);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({status:'stale'});
 }
 expect(await voteRows(DB)).toHaveLength(3);
 // A client that displays B can vote, and B starts with no inherited ratings.
 for(const n of [2,3,4]) expect((await route(env,{url:item.url,lang:'en',vote:'up',token:token(n),take:hashB},now)).status).toBe(200);
 const view=await readLighterFeedback(env);
 // Totals stay honest: A's three votes are still counted, never reassigned to B.
 expect(view).toMatchObject({available:true,up:6,down:0,ratedTakes:1});
 if(!view.available)return;
 // The example is the current text B with only B's own three votes.
 expect(view.top).toHaveLength(1);
 expect(view.top[0]).toMatchObject({text:textB,ups:3,downs:0});
 expect(view.bottom).toEqual([]);
 // A vote bound to the old text A never rates B, and B's retract removes only B's row.
 expect((await route(env,{url:item.url,lang:'en',vote:'none',token:token(2),take:hashB},now)).status).toBe(200);
 const after=await readLighterFeedback(env);
 // B now has two votes: still a rated take, but below the minimum sample for examples.
 expect(after).toMatchObject({up:5,ratedTakes:1});
 if(!after.available)return;
 expect(after.top).toEqual([]);
 expect(after.bottom).toEqual([]);
 // The stale rows stay in the honest historical ledger: no delete ever ran for them.
 expect(await voteRows(DB)).toHaveLength(5);
});

it('bounds vote writes with the global per-minute bucket only',async()=>{
 const DB=database();
 await seedArticle(DB,item);
 await seedTake(DB,item,'en',takeEn);
 const env={DB} as unknown as Env;
 const now=Date.UTC(2026,10,20,12,0,0);
 const bucket=Math.floor(now/60000);
 const shown=await takeHashOf(takeEn);
 // A full bucket refuses before any write and prunes old buckets.
 await DB.prepare('INSERT INTO lighter_vote_rate(bucket,hits) VALUES(?,?)').bind(bucket-3,5).run();
 await DB.prepare('INSERT INTO lighter_vote_rate(bucket,hits) VALUES(?,?)').bind(bucket,FEEDBACK_RATE_PER_MINUTE).run();
 const refused=await route(env,{url:item.url,lang:'en',vote:'up',token:token(1),take:shown},now);
 expect(refused.status).toBe(429);
 expect(await refused.json()).toEqual({status:'rate'});
 expect((await DB.prepare('SELECT COUNT(*) AS n FROM lighter_vote_rate WHERE bucket=?').first<{n:number}>())!.n).toBe(0);
 expect(await voteRows(DB)).toHaveLength(0);
 await DB.prepare('DELETE FROM lighter_vote_rate').run();
 // No in-flight lease exists to refuse honest concurrent voters: a vote is one
 // cheap D1 write, so nothing but the per-minute bucket bounds concurrency.
 expect((await route(env,{url:item.url,lang:'en',vote:'up',token:token(1),take:shown},now)).status).toBe(200);
 expect((await DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='lighter_vote_inflight'").first<{n:number}>())!.n).toBe(0);
});

it('aggregates totals and minimum-sample examples without identifiers',async()=>{
 const DB=database();
 const a=story('https://example.com/a','Traffic delays','The agency reports traffic delays.');
 const b=story('https://example.com/b','Traffic delays continue','The agency reports more traffic delays.');
 const c=story('https://example.com/c','Traffic delays persist','The agency reports ongoing traffic delays.');
 for (const it of [a,b,c]) { await seedArticle(DB,it); await seedTake(DB,it,'en',takeEn); }
 await DB.prepare('INSERT INTO story_ids(id,url) VALUES(?,?)').bind(7,a.url).run();
 const env={DB} as unknown as Env;
 const now=Date.UTC(2026,10,20,12,0,0);
 const shown=await takeHashOf(takeEn);
 for (let n=1;n<=3;n++) expect((await route(env,{url:a.url,lang:'en',vote:'up',token:token(n),take:shown},now)).status).toBe(200);
 for (let n=11;n<=13;n++) expect((await route(env,{url:b.url,lang:'en',vote:'down',token:token(n),take:shown},now)).status).toBe(200);
 expect((await route(env,{url:c.url,lang:'en',vote:'up',token:token(21),take:shown},now)).status).toBe(200);
 const view=await readLighterFeedback(env);
 expect(view).toMatchObject({available:true,up:4,down:3,ratedTakes:3,minSample:FEEDBACK_MIN_SAMPLE});
 if(!view.available)return;
 // One vote is below the minimum sample, so c is counted but never shown as best or worst.
 expect(view.top.map(example=>example.url)).toEqual([a.url]);
 expect(view.top[0]).toMatchObject({lang:'en',title:a.title,text:takeEn,ups:3,downs:0,storyId:null});
 expect(view.bottom.map(example=>example.url)).toEqual([b.url]);
 expect(view.bottom[0]).toMatchObject({ups:0,downs:3});
 await attachStoryIds(env,[...view.top,...view.bottom]);
 expect(view.top[0].storyId).toBe(7);
 expect(view.bottom[0].storyId).toBeNull();
 // A take whose stored text was replaced (here by a line the guard hides) keeps its
 // counted votes in the totals, but they are bound to the replaced text: the key no
 // longer counts as a take with a current vote and is not displayed as an example.
 await DB.prepare('UPDATE lighter_cache SET text=? WHERE key=?').bind('nope',key(b,'en')).run();
 const hidden=await readLighterFeedback(env);
 expect(hidden).toMatchObject({available:true,up:4,down:3,ratedTakes:2});
 if(!hidden.available)return;
 expect(hidden.top.map(example=>example.url)).toEqual([a.url]);
 expect(hidden.bottom).toEqual([]);
 // Missing table: unavailable, never zeros.
 const bare=database(['migrations/0001_live.sql','migrations/0011_lighter.sql']);
 expect(await readLighterFeedback({DB:bare} as Env)).toEqual({available:false});
});

it('keeps the additive migration replayable',()=>{
 const sqlite=new DatabaseSync(':memory:');
 for (const file of ['migrations/0001_live.sql','migrations/0011_lighter.sql']) sqlite.exec(readFileSync(file,'utf8'));
 sqlite.exec(readFileSync('migrations/0016_lighter_votes.sql','utf8'));
 sqlite.exec(readFileSync('migrations/0016_lighter_votes.sql','utf8'));
 sqlite.exec("INSERT INTO lighter_votes(token_hash,cache_key,take_hash,vote,voted_at) VALUES ('h','k','t','up',1)");
 sqlite.exec('INSERT INTO lighter_vote_rate(bucket,hits) VALUES(1,1)');
 expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lighter_votes').get()).toEqual({n:1});
 expect(sqlite.prepare("SELECT vote FROM lighter_votes WHERE token_hash='h' AND cache_key='k' AND take_hash='t'").get()).toEqual({vote:'up'});
});

it('renders the aggregate on /stats separately from generation counts and clicks',async()=>{
 const DB=database();
 const a=story('https://example.com/a','Traffic delays','The agency reports traffic delays.');
 const b=story('https://example.com/b','Traffic delays continue','The agency reports more traffic delays.');
 for (const it of [a,b]) { await seedArticle(DB,it); await seedTake(DB,it,'en',takeEn); }
 const env={DB} as unknown as Env;
 const shown=await takeHashOf(takeEn);
 for (let n=1;n<=3;n++) expect((await workerPost(env,{url:a.url,lang:'en',vote:'up',token:token(n),take:shown})).status).toBe(200);
 for (let n=11;n<=13;n++) expect((await workerPost(env,{url:b.url,lang:'en',vote:'down',token:token(n),take:shown})).status).toBe(200);
 const html=await (await worker.fetch(new Request('https://news.dev.pr/stats?lang=en'),env)).text();
 expect(html.indexOf('id="lighter-stats"')).toBeGreaterThan(-1);
 expect(html.indexOf('id="lighter-feedback"')).toBeGreaterThan(html.indexOf('id="lighter-stats"'));
 expect(html.indexOf('id="clics"')).toBeGreaterThan(html.indexOf('id="lighter-feedback"'));
 const section=html.slice(html.indexOf('id="lighter-feedback"'),html.indexOf('id="clics"'));
 expect(section).toContain('Votes on satire takes');
 expect(section).toContain('Up votes: 3 · Down votes: 3 · Takes with at least one vote: 2');
 expect(section).toContain('Most up-voted');
 expect(section).toContain(a.title);
 expect(section).toContain(takeEn);
 expect(section).toContain('Most down-voted');
 expect(section).toContain(b.title);
 expect(section).toContain('Examples require at least '+FEEDBACK_MIN_SAMPLE);
 expect(section).toContain('not a definitive ranking');
 expect(section).toContain('one anonymous browser');
 // No identifier is ever public: no token, no hash, no per-person data.
 expect(section).not.toContain(token(1));
 expect(section).not.toMatch(/[0-9a-f]{64}/);
 // An unavailable read stays honest instead of showing zeros.
 const missing=database(['migrations/0001_live.sql','migrations/0011_lighter.sql']);
 const failed=await (await worker.fetch(new Request('https://news.dev.pr/stats?lang=en'),{DB:missing} as unknown as Env)).text();
 expect(failed).toContain('The vote read is unavailable.');
 expect(failed).not.toContain('Up votes:');
});

it('ships vote controls for a shared satire=1 story and hides them from the served HTML',async()=>{
 const DB=database();
 await seedArticle(DB,item);
 await seedTake(DB,item,'es',takeEs);
 await DB.prepare('INSERT INTO story_ids(id,url) VALUES(?,?)').bind(7,item.url).run();
 const env={DB} as unknown as Env;
 // The Spanish edition: the untranslated Spanish-source story is readable there.
 const page=await (await worker.fetch(new Request('https://news.dev.pr/story?id=7&satire=1'),env)).text();
 expect(page).toContain(takeEs);
 expect(page).toContain('data-mode="open"');
 expect(page).toContain('AI Satire');
 // The controls are built by the client script only after the take is on the page:
 // the script text ships, but no vote-control markup does.
 expect(page).not.toContain('class="lighter-vote');
 expect(page).toContain('prnews-lighter-vote-token');
 const plain=await (await worker.fetch(new Request('https://news.dev.pr/story?id=7'),env)).text();
 expect(plain).not.toContain(takeEs);
 expect(plain).toContain('prnews-lighter-vote-token');
 const home=await (await worker.fetch(new Request('https://news.dev.pr/'),env)).text();
 expect(home).toContain('prnews-lighter-vote-token');
 expect(home).toContain('data-lighter-url="'+item.url+'"');
});

it('keeps the client copy accessible, localized, and free of unsafe DOM sinks',()=>{
 for (const source of [lighterFeedbackClientScript,lighterClientScript]) {
  expect(source).not.toContain('innerHTML');
  expect(source).not.toContain('document.write');
 }
 expect(lighterClientScript).toContain('prnews:satire');
 expect(lighterFeedbackClientScript).toContain('aria-pressed');
 expect(lighterFeedbackClientScript).toContain('Me gusta esta sátira');
 expect(lighterFeedbackClientScript).toContain('No me gusta esta sátira');
 expect(lighterFeedbackClientScript).toContain('I like this satire');
 expect(lighterFeedbackClientScript).toContain('I dislike this satire');
 expect(lighterFeedbackClientScript).toContain('prnews-lighter-vote-token');
 expect(lighterFeedbackClientScript).toContain('prnews-lighter-votes');
 expect(lighterFeedbackClientScript).toContain("'/api/lighter-vote'");
 expect(lighterFeedbackClientScript).toContain("'X-PRNews-Action':'lighter-vote'");
 expect(lighterFeedbackClientScript).toContain('crypto.randomUUID');
 // The vote binds to the exact displayed text and a stale client is told to reopen.
 expect(lighterFeedbackClientScript).toContain('prnews-lighter-take:');
 expect(lighterFeedbackClientScript).toContain('This satire is no longer the current version.');
 expect(lighterFeedbackClientScript).toContain('Esta sátira ya no es la versión actual.');
 expect(lighterFeedbackClientScript).not.toContain(token(1));
});

/** Minimal DOM stub: enough for the vote controls, textContent-only, like the page. */
function fixture(lineText:string){
 const listeners:Record<string,(event:unknown)=>void>={};
 const storage=new Map<string,string>();
 const matches=(node:any,sel:string)=>{
  const cls=String(node.attrs['class']??'').split(/\s+/).filter(Boolean);
  if(sel==='.lighter-vote-btn')return cls.includes('lighter-vote-btn');
  if(sel==='.lighter-vote')return cls.includes('lighter-vote');
  if(sel==='.lighter-vote-note')return cls.includes('lighter-vote-note');
  if(sel==='.lighter-note')return cls.includes('lighter-note');
  if(sel==='.lighter-ask')return cls.includes('lighter-ask');
  if(sel==='span')return node.tag==='span';
  return false;
 };
 const findAll=(node:any,sel:string):any[]=>{
  const out:any[]=[];
  if(matches(node,sel))out.push(node);
  for(const child of node.children)out.push(...findAll(child,sel));
  return out;
 };
 const make=(tag:string,text=''):any=>{
  const node:any={tag,children:[],attrs:{},parentNode:null,disabled:false,_text:text};
  node.setAttribute=(n:string,v:string)=>{node.attrs[n]=String(v);};
  node.getAttribute=(n:string)=>n in node.attrs?String(node.attrs[n]):null;
  node.removeAttribute=(n:string)=>{delete node.attrs[n];};
  node.appendChild=(child:any)=>{child.parentNode=node;node.children.push(child);return child;};
  Object.defineProperty(node,'textContent',{get(){let t=node._text??'';for(const child of node.children)t+=child.textContent;return t;},set(v:string){node.children=[];node._text=String(v);}});
  node.querySelector=(sel:string)=>findAll(node,sel)[0]??null;
  node.querySelectorAll=(sel:string)=>findAll(node,sel);
  node.closest=(sel:string)=>{for(let cur=node;cur;cur=cur.parentNode)if(matches(cur,sel))return cur;return null;};
  Object.defineProperty(node,'className',{get(){return String(node.attrs['class']??'');},set(v:string){node.attrs['class']=String(v);}});
  Object.defineProperty(node,'type',{get(){return String(node.attrs['type']??'');},set(v:string){node.attrs['type']=String(v);}});
  Object.defineProperty(node,'title',{get(){return String(node.attrs['title']??'');},set(v:string){node.attrs['title']=String(v);}});
  return node;
 };
 const line=make('span',lineText);
 const note=make('p');note.setAttribute('class','lighter-note');note.appendChild(line);
 const ask=make('button');ask.setAttribute('class','lighter-ask');ask.setAttribute('data-lighter-url',item.url);ask.setAttribute('data-lighter-lang','en');
 const container=make('div');container.appendChild(ask);container.appendChild(note);
 const documentStub:any={
  addEventListener(type:string,fn:(event:unknown)=>void){listeners[type]=fn;},
  createElement(tag:string){return make(tag);},
  documentElement:{lang:'en'},
  querySelectorAll(sel:string){return sel==='.lighter-note'?[note]:[];},
 };
 const localStorageStub={
  getItem(k:string){return storage.has(k)?storage.get(k)!:null;},
  setItem(k:string,v:string){storage.set(k,v);},
  removeItem(k:string){storage.delete(k);},
 };
 const fetchMock=vi.fn(async (_url:string, _init?:RequestInit)=>({ok:true,status:200,json:async()=>({status:'ok'})}));
 return {listeners,storage,documentStub,localStorageStub,fetchMock,note};
}

async function withPage(lineText:string,run:(page:ReturnType<typeof fixture>,flush:()=>Promise<void>)=>Promise<void>,blockStorage=false,noSubtle=false){
 const page=fixture(lineText);
 const cryptoDesc=Object.getOwnPropertyDescriptor(globalThis,'crypto')!;
 const previous={document:globalThis.document,fetch:globalThis.fetch,localStorage:globalThis.localStorage};
 const flush=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
 globalThis.document=page.documentStub as unknown as Document;
 globalThis.fetch=page.fetchMock as unknown as typeof fetch;
 globalThis.localStorage=(blockStorage?{
  getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');},removeItem(){throw new Error('blocked');},
 }:page.localStorageStub) as unknown as Storage;
 // A browser can offer crypto.randomUUID but not crypto.subtle (for example a very
 // old script engine): voting must then fail honestly with no request.
 if(noSubtle)Object.defineProperty(globalThis,'crypto',{configurable:true,get:()=>({randomUUID:()=>'12345678-1234-4123-8123-123456789abc'})});
 try { eval(lighterFeedbackClientScript); await run(page,flush); }
 finally {
  globalThis.document=previous.document; globalThis.fetch=previous.fetch; globalThis.localStorage=previous.localStorage;
  if(noSubtle)Object.defineProperty(globalThis,'crypto',cryptoDesc);
 }
}

it('builds controls under a displayed line, votes, changes, and retracts',async()=>{
 await withPage(takeEn,async(page,flush)=>{
  const wrap=page.note.querySelector('.lighter-vote');
  expect(wrap).toBeTruthy();
  // The shared satire=1 scan built the same controls the paint event builds.
  const buttons=wrap.querySelectorAll('.lighter-vote-btn');
  expect(buttons).toHaveLength(2);
  expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
  expect(buttons[0].getAttribute('aria-label')).toBe('I like this satire');
  expect(buttons[1].getAttribute('aria-label')).toBe('I dislike this satire');
  // Hide wipes the note; a fresh paint (line first, then the event) rebuilds the controls.
  page.note.textContent='';
  expect(page.note.querySelector('.lighter-vote')).toBeNull();
  const again=page.documentStub.createElement('span');
  again.textContent=takeEn;
  page.note.appendChild(again);
  page.listeners['prnews:satire']({target:page.note,detail:{url:item.url,lang:'en',text:takeEn}});
  const rebuilt=page.note.querySelector('.lighter-vote');
  expect(rebuilt.querySelector('.lighter-vote-btn')).toBeTruthy();
  const up=rebuilt.querySelectorAll('.lighter-vote-btn')[0];
  const down=rebuilt.querySelectorAll('.lighter-vote-btn')[1];
  // Vote up.
  page.listeners['click']({target:up});
  await flush();await flush();
  expect(page.fetchMock).toHaveBeenCalledTimes(1);
  const sent=JSON.parse(String(page.fetchMock.mock.calls[0][1]?.body??''));
  expect(sent).toMatchObject({url:item.url,lang:'en',vote:'up'});
  // The vote names the SHA-256 of the exact displayed text, so it binds to this
  // generation and a later regenerated text can never inherit the rating.
  expect(sent.take).toBe(await takeHashOf(takeEn));
  expect(String(sent.token)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(up.getAttribute('aria-pressed')).toBe('true');
  expect(down.getAttribute('aria-pressed')).toBe('false');
  expect(JSON.parse(page.storage.get('prnews-lighter-votes')!)).toEqual({[Object.keys(JSON.parse(page.storage.get('prnews-lighter-votes')!))[0]]:'up'});
  expect(rebuilt.querySelector('.lighter-vote-note').textContent).toBe('Thanks for your vote!');
  // Pressing the pressed button retracts.
  page.listeners['click']({target:up});
  await flush();await flush();
  expect(JSON.parse(String(page.fetchMock.mock.calls[1][1]?.body??''))).toMatchObject({vote:'none'});
  expect(up.getAttribute('aria-pressed')).toBe('false');
  expect(JSON.parse(page.storage.get('prnews-lighter-votes')!)).toEqual({});
  expect(rebuilt.querySelector('.lighter-vote-note').textContent).toBe('Your vote was removed.');
  // The other button changes the vote.
  page.listeners['click']({target:down});
  await flush();await flush();
  expect(JSON.parse(String(page.fetchMock.mock.calls[2][1]?.body??''))).toMatchObject({vote:'down'});
  expect(down.getAttribute('aria-pressed')).toBe('true');
  expect(up.getAttribute('aria-pressed')).toBe('false');
 });
});

it('fails honestly when browser storage is blocked',async()=>{
 await withPage(takeEn,async(page,flush)=>{
  const wrap=page.note.querySelector('.lighter-vote');
  page.listeners['click']({target:wrap.querySelectorAll('.lighter-vote-btn')[0]});
  await flush();await flush();
  expect(page.fetchMock).not.toHaveBeenCalled();
  expect(wrap.querySelector('.lighter-vote-note').textContent).toBe('Could not save the vote. Try again.');
 },true);
});

it('fails honestly without crypto.subtle: no request, no hidden write',async()=>{
 await withPage(takeEn,async(page,flush)=>{
  const wrap=page.note.querySelector('.lighter-vote');
  page.listeners['click']({target:wrap.querySelectorAll('.lighter-vote-btn')[0]});
  await flush();await flush();
  expect(page.fetchMock).not.toHaveBeenCalled();
  expect(wrap.querySelector('.lighter-vote-note').textContent).toBe('Could not save the vote. Try again.');
 },false,true);
});

it('tells a stale client to reopen the satire instead of rating a replacement',async()=>{
 await withPage(takeEn,async(page,flush)=>{
  const wrap=page.note.querySelector('.lighter-vote');
  page.fetchMock.mockResolvedValueOnce({ok:false,status:409,json:async()=>({status:'stale'})});
  page.listeners['click']({target:wrap.querySelectorAll('.lighter-vote-btn')[0]});
  await flush();await flush();
  expect(page.fetchMock).toHaveBeenCalledTimes(1);
  const sent=JSON.parse(String(page.fetchMock.mock.calls[0][1]?.body??''));
  expect(sent.take).toBe(await takeHashOf(takeEn));
  expect(wrap.querySelector('.lighter-vote-note').textContent).toBe('This satire is no longer the current version. Hide it and show it again to vote on the new one.');
  // The buttons are re-enabled and nothing was recorded locally.
  expect(wrap.querySelectorAll('.lighter-vote-btn')[0].disabled).toBe(false);
  expect(page.storage.has('prnews-lighter-votes')).toBe(false);
 });
});

it('renders no vote numbers without the view and keeps the stats copy bilingual',async()=>{
 for (const lang of ['es','en'] as const) {
  const html=await renderer.fetch(new Request('https://news.dev.pr/stats?lang='+lang),{items:[],translations:{},feeds:[]}).text();
  const section=html.slice(html.indexOf('id="lighter-feedback"'),html.indexOf('id="clics"'));
  expect(section).toContain(lang==='es'?'La lectura de votos no está disponible.':'The vote read is unavailable.');
  expect(section).not.toContain('Up votes:');
  expect(section).not.toContain('Votos a favor:');
 }
});
