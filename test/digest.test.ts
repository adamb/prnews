import {describe,it,expect,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {subscribe,confirm,unsubscribe,runDigest,selectStories,renderDigest,eligibleDigestCutoff,type DigestEnv} from '../src/digest';
import type {Item} from '../src/parse';
function database() {
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync('migrations/0001_live.sql','utf8'));
 db.exec(readFileSync('migrations/0004_digest.sql','utf8'));
 return {prepare:(sql:string)=>({bind:(...args:any[])=>({first:async()=>db.prepare(sql).get(...args)??null,all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>({meta:{changes:db.prepare(sql).run(...args).changes}})})})} as unknown as D1Database;
}
const item=(source:string,time:number,title='Headline'):Item=>({source,time,title,url:`https://example.com/${source}/${time}`,summary:'A complete excerpt sentence.',image:'',observed:false,section:'otras',reason:''});
describe('digest',()=>{
 it('selects recent diverse news and escapes hostile HTML',()=>{
  const items=[item('a',99),item('a',98),item('b',97),item('c',96)];
  expect(selectStories(items,100,3).map(i=>i.source)).toEqual(['a','b','c']);
  const hostile=item('a',99,'<img src=x onerror=alert(1)>');
  const mail=renderDigest([{es:hostile,en:null,importanceEs:'',importanceEn:''}],'es','https://news.dev.pr/digest/unsubscribe?token=x');
  expect(mail.html).toContain('lang="es"');expect(mail.html).toContain('lang="en"');expect(mail.subject).toBe('El resumen de la isla');
  expect(mail.html).not.toContain('<img'); expect(mail.html).toContain('&lt;img'); expect(mail.text).toContain('Unsubscribe');
 });
 it('returns unavailable before any database or network work',async()=>{
  expect((await subscribe({} as DigestEnv,'a@example.com')).status).toBe('unavailable');
  expect((await runDigest({} as DigestEnv)).status).toBe('unavailable');
 });
 it('double opt-in, expiry, suppression and daily idempotency',async()=>{
  const DB=database(),now=Date.now(),env:DigestEnv={DB,DIGEST_ENABLED:'true',RESEND_API_KEY:'fake',DIGEST_FROM:'News <news@example.com>',DIGEST_TOKEN_SECRET:'x'.repeat(32)};
  const messages:any[]=[];
  const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{messages.push(JSON.parse(String(init?.body)));return new Response('{}');});
  try {
   await subscribe(env,'reader@example.com','es',now-1000);
   expect(messages).toHaveLength(1);
   const token=/confirm\?token=([a-f0-9]+)/.exec(messages[0].text)![1];
   const pending=await DB.prepare('SELECT * FROM digest_subscribers').bind().first<any>();
   expect(pending.status).toBe('pending'); expect(pending.confirm_hash).not.toBe(token);
   await confirm(env,token,now+86400000); expect((await DB.prepare('SELECT status FROM digest_subscribers').bind().first<any>()).status).toBe('pending');
   await confirm(env,token,now); await confirm(env,token,now);
   await subscribe(env,'reader@example.com','es',now); expect(messages).toHaveLength(1);
   const story=item('nimb',now-100);
   await DB.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)').bind(story.url,story.source,JSON.stringify(story),now,now,story.time).run();
   await runDigest(env,now); await runDigest(env,now);
   expect(messages).toHaveLength(2);
   const stop=/unsubscribe\?token=([a-f0-9]+)/.exec(messages[1].text)![1];
   await unsubscribe(env,stop); await confirm(env,token,now);
   expect((await DB.prepare('SELECT status FROM digest_subscribers').bind().first<any>()).status).toBe('unsubscribed');
   await runDigest(env,now+1000); expect(messages).toHaveLength(2);
  } finally {mock.mockRestore();}
 });
 it('never uses ImprovMX for confirmations or newsletters',async()=>{
  const env:DigestEnv={DB:database(),IMPROVMX_API_KEY:'fake',DIGEST_ENABLED:'true',DIGEST_FROM:'digest@example.com',DIGEST_TOKEN_SECRET:'x'.repeat(32)};
  const mock=vi.spyOn(globalThis,'fetch');
  try {expect((await subscribe(env,'reader@example.com')).status).toBe('unavailable');expect((await runDigest(env)).status).toBe('unavailable');expect(mock).not.toHaveBeenCalled();} finally {mock.mockRestore();}
 });
 const env=():DigestEnv=>({DB:database(),DIGEST_ENABLED:'true',RESEND_API_KEY:'fake',DIGEST_FROM:'News <news@example.com>',DIGEST_TOKEN_SECRET:'x'.repeat(32)});
 async function seedRecipients(DB:D1Database,ids:string[],now:number,cutoff:number) {
  for(const id of ids) await DB.prepare("INSERT INTO digest_subscribers(id,email,language,status,unsubscribe_hash,last_request,request_day,confirmed_at) VALUES(?,?, 'es','active',?,?,?,?)").bind(id,id+'@x.com','u'+id,now,1,cutoff-2000).run();
  const story=item('nim',cutoff-100);
  await DB.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)').bind(story.url,story.source,JSON.stringify(story),now,now,story.time).run();
 }
 const row=(DB:D1Database,subscriber='s1')=>DB.prepare('SELECT * FROM digest_deliveries WHERE subscriber=?').bind(subscriber).first<any>();
 describe('provider failure and retry budgets',()=>{
  it('resumes ambiguous network failures as pending and retries under the same idempotency key',async()=>{
   const e=env(),DB=e.DB,now=Date.now();
   await seedRecipients(DB,['s1'],now,now-1000);
   let calls=0; const keys:string[]=[];
   const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
    keys.push((init?.headers as Record<string,string>)['Idempotency-Key']);
    if(calls++===0) throw new TypeError('network down'); // timeout/connection loss; acceptance unknown.
    return new Response('{}');});
   try {
    await runDigest(e,now-500);
    const afterFail=await row(DB);
    expect(afterFail.state).toBe('pending'); expect(afterFail.attempts).toBe(1);
    expect(afterFail.lease_until).toBeGreaterThan(now+240000); // ≥5 minute backoff
    // Simulate the lease expiring instead of sleeping.
    await DB.prepare('UPDATE digest_deliveries SET lease_until=? WHERE subscriber=\'s1\'').bind(now-1).run();
    await runDigest(e,now-500);
    expect((await row(DB)).state).toBe('sent');
    expect(keys[0]).toMatch(/^digest\/\d{4}-\d{2}-\d{2}\/s1$/); // stable key on both attempts
    expect(keys[1]).toBe(keys[0]);
    await DB.prepare('UPDATE digest_deliveries SET lease_until=? WHERE subscriber=\'s1\'').bind(now-1).run();
    await runDigest(e,now-500); const onlyOnce=calls;
    expect(onlyOnce).toBe(2); // delivered rows are not re-sent
   } finally {mock.mockRestore();}
  });
  it('honors Retry-After on 429 without consuming attempts and stops the batch',async()=>{
   const e=env(),DB=e.DB,now=Date.now();
   await seedRecipients(DB,['s1','s2'],now,now-1000);
   const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('{}',{status:429,headers:{'Retry-After':'120'}}));
   try {
    await runDigest(e,now-500);
    expect(mock).toHaveBeenCalledTimes(1); // batch stops at the first throttle
    const throttled=await row(DB,'s1'),skipped=await row(DB,'s2');
    expect(throttled.state).toBe('pending'); expect(throttled.attempts).toBe(0); // 429 costs no attempt
    expect(throttled.lease_until).toBeGreaterThanOrEqual(now+119000); // honors the 120s Retry-After
    expect(skipped.state).toBe('pending');
   } finally {mock.mockRestore();}
  });
  it('backs off on 5xx and treats definite 4xx rejections as terminal failed',async()=>{
   const e=env(),DB=e.DB,now=Date.now();
   await seedRecipients(DB,['s1','s2'],now,now-1000);
   const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    return body.to[0]==='s1@x.com' ? new Response('{}',{status:500}) : new Response('validation',{status:422});});
   try {
    await runDigest(e,now-500);
    const ambiguous=await row(DB,'s1'),rejected=await row(DB,'s2');
    expect(ambiguous.state).toBe('pending'); expect(ambiguous.attempts).toBe(1);
    expect(ambiguous.lease_until).toBeGreaterThan(now+240000);
    expect(rejected.state).toBe('failed'); expect(rejected.attempts).toBe(1);
    mock.mockRestore();
    // Expire the 5-minute backoff lease, then retry: only the ambiguous row goes out again.
    await DB.prepare("UPDATE digest_deliveries SET lease_until=? WHERE subscriber='s1'").bind(now-1).run();
    const quiet=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('{}'));
    try {
     await runDigest(e,now-500); await runDigest(e,now-500);
     expect(quiet).toHaveBeenCalledTimes(1); // only the ambiguous row retries; failed is terminal
     expect((await row(DB,'s1')).state).toBe('sent');
     expect((await row(DB,'s2')).state).toBe('failed');
    } finally {quiet.mockRestore();}
   } finally {mock.mockRestore();}
  });
  it('recovers stalled sending rows and legacy uncertain rows to an idempotent send',async()=>{
   const e=env(),DB=e.DB,now=Date.now();
   await seedRecipients(DB,['s1','s2'],now,now-1000);
   await DB.prepare("UPDATE digest_deliveries SET state='sending',lease_until=?,attempts=1,first_attempt=? WHERE subscriber='s1'").bind(now-1,now-1000).run();
   await DB.prepare("UPDATE digest_deliveries SET state='uncertain',lease_until=0,attempts=1,first_attempt=? WHERE subscriber='s2'").bind(now-1000).run();
   const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('{}'));
   try {
    await runDigest(e,now-500);
    expect(mock).toHaveBeenCalledTimes(2);
    expect((await row(DB,'s1')).state).toBe('sent');
    expect((await row(DB,'s2')).state).toBe('sent');
   } finally {mock.mockRestore();}
  });
  it('keeps rows beyond five attempts or the 23-hour retry window unclaimed',async()=>{
   const e=env(),DB=e.DB,now=Date.now();
   await seedRecipients(DB,['s1'],now,now-1000);
   const day=new Date(now-500).toISOString().slice(0,10);
   await DB.prepare(`INSERT INTO digest_deliveries(day,subscriber,language,state,attempts,lease_until,first_attempt) VALUES('${day}','s1','es','pending',5,0,?)`).bind(now-1000).run();
   const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('{}'));
   try {
    await runDigest(e,now-500); expect(mock).not.toHaveBeenCalled(); // attempts exhausted
    await DB.prepare("UPDATE digest_deliveries SET attempts=1,first_attempt=? WHERE subscriber='s1'").bind(now-23*3600000-1).run();
    await runDigest(e,now-500); expect(mock).not.toHaveBeenCalled(); // past the 23h idempotent retry window
    await DB.prepare("UPDATE digest_deliveries SET attempts=1,first_attempt=NULL WHERE subscriber='s1'").bind().run();
    await runDigest(e,now-500);
    expect(mock).toHaveBeenCalledTimes(1); // the guards, not the row state, were blocking
   } finally {mock.mockRestore();}
  });
 });
 describe('daily cutoff across midnight',()=>{
  it('eligibleDigestCutoff pins the most recent 10:30 UTC boundary on both sides of midnight',()=>{
   const before=Date.parse('2026-03-14T10:30:00Z');
   expect(eligibleDigestCutoff(Date.parse('2026-03-15T00:00:00Z'))).toBe(before);
   expect(eligibleDigestCutoff(Date.parse('2026-03-15T10:29:59.999Z'))).toBe(before);
   expect(eligibleDigestCutoff(Date.parse('2026-03-15T10:30:00.001Z'))).toBe(Date.parse('2026-03-15T10:30:00Z'));
   expect(eligibleDigestCutoff(Date.parse('2026-03-15T23:59:59Z'))).toBe(Date.parse('2026-03-15T10:30:00Z'));
   expect(eligibleDigestCutoff(Date.parse('2026-03-15T10:30:00Z'))).toBe(Date.parse('2026-03-15T10:30:00Z'));
  });
  it('continuations after UTC midnight reuse the previous day snapshot; a new day starts only at 10:30 UTC',async()=>{
   const e=env(),DB=e.DB;
   const cutoff=Date.parse('2026-03-14T10:30:00Z');
   await seedRecipients(DB,['s1'],cutoff,cutoff);
   const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('{}'));
   try {
    await runDigest(e,cutoff);
    expect((await row(DB)).state).toBe('sent');
    // After UTC midnight the eligible cutoff is still the previous day's 10:30 boundary.
    const afterMidnight=eligibleDigestCutoff(Date.parse('2026-03-15T00:05:00Z'));
    expect(afterMidnight).toBe(cutoff);
    await runDigest(e,afterMidnight);
    let days=await DB.prepare('SELECT COUNT(*) n FROM digest_days').bind().first<any>();
    expect(days.n).toBe(1); // same day key, no fresh snapshot before 10:30 UTC
    expect(mock).toHaveBeenCalledTimes(1); // delivered row is not duplicated
    // At 10:31 UTC the next cycle begins, with its own snapshot and delivery day key.
    const nextStory=item('nim',Date.parse('2026-03-15T08:00:00Z'));
    await DB.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)').bind(nextStory.url,nextStory.source,JSON.stringify(nextStory),cutoff,cutoff,nextStory.time).run();
    await runDigest(e,eligibleDigestCutoff(Date.parse('2026-03-15T10:31:00Z')));
    days=await DB.prepare('SELECT COUNT(*) n FROM digest_days').bind().first<any>();
    expect(days.n).toBe(2);
    const rows=await DB.prepare('SELECT day,state FROM digest_deliveries ORDER BY day').bind().all<any>();
    expect(rows.results.map(r=>[r.day,r.state])).toEqual([['2026-03-14','sent'],['2026-03-15','sent']]);
    expect(mock).toHaveBeenCalledTimes(2);
   } finally {mock.mockRestore();}
  });
 });
});
