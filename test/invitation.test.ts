/**
 * Keyword-alert invitation: bilingual rotating variants with lang-preserving links on public
 * reading routes only; a client script that waits, asks the boolean endpoint, keeps one
 * invitation per America/Puerto_Rico calendar day (dismissal/CTA/show suppress every variant
 * for the rest of the same AST day) and advances a deterministic round-robin variant index
 * only on actual displays; plus the boolean /api/alerts-active endpoint that suppresses the
 * invitation for a signed-in browser with active alerts — answering one bit, never an email
 * or phrase, always no-store, and never varying the shared cached page HTML.
 */
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import renderer, {type LiveData} from '../src/render';
import {alertsRoute, alertsActiveRoute} from '../src/alerts-http';
import {INVITE_KEY, INVITE_DELAY_MS, INVITE_VARIANT_COUNT, AST_UTC_OFFSET_MS, INVITE_VARIANTS, astDayKey, inviteEligible, invitationScript} from '../src/invitation';
import type {AlertEnv} from '../src/alerts';
import type {Item} from '../src/parse';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/* ------------------------------------------------ markup, copy and routes */

const item=(url:string):Item=>({url,source:'noticel',title:'Titular de prueba',summary:'Extracto de prueba.',image:'',time:Date.now(),observed:false,section:'negocios',reason:''});
const data=(extra:Partial<LiveData>={}):LiveData=>({items:[item('https://example.org/a')],translations:{},feeds:[],...extra});

it('renders all bilingual variants coherently with a lang-preserving CTA and close label',async()=>{
 const es=await renderer.fetch(new Request('https://news.dev.pr/'),data()).text();
 expect(es.match(/data-variant="\d"/g)?.length).toBe(INVITE_VARIANT_COUNT);
 for(const [i,variant] of INVITE_VARIANTS.entries()){
  expect(es).toContain(`data-variant="${i}"`);
  expect(es).toContain(variant.es.title);
  expect(es).toContain(variant.es.body);
  expect(es).toContain('máximo un correo por hora'); // batched delivery, never an instant promise
 }
 expect(es.match(/>Crear mis alertas<\/a>/g)?.length).toBe(INVITE_VARIANT_COUNT);
 expect(es.match(/href="\/alerts\?lang=es"/g)?.length).toBeGreaterThanOrEqual(INVITE_VARIANT_COUNT);
 expect(es.match(/aria-label="Cerrar"/g)?.length).toBe(INVITE_VARIANT_COUNT);
 expect(es).not.toContain('Want to know when they mention your company?');
 const en=await renderer.fetch(new Request('https://news.dev.pr/?lang=en'),data()).text();
 for(const [i,variant] of INVITE_VARIANTS.entries()){
  expect(en).toContain(`data-variant="${i}"`);
  expect(en).toContain(variant.en.title);
  expect(en).toContain(variant.en.body);
  expect(en).toContain('at most one email per hour');
 }
 expect(en.match(/>Create my alerts<\/a>/g)?.length).toBe(INVITE_VARIANT_COUNT);
 expect(en.match(/href="\/alerts\?lang=en"/g)?.length).toBeGreaterThanOrEqual(INVITE_VARIANT_COUNT);
 expect(en.match(/aria-label="Close"/g)?.length).toBe(INVITE_VARIANT_COUNT);
 expect(en).not.toContain('¿Quieres saber cuándo mencionan tu empresa?');
});

it('offers the invitation only on public reading routes; utility, signup, alerts, error and result pages are excluded',async()=>{
 const storyData=data({story:true,storyIds:{['https://example.org/a']:1}});
 const archiveData=data({archive:{rows:[{id:1,url:'https://example.org/a',captured_at:Date.now(),image_url:'',object_key:null,error:null,attempts:null}],next:null,date:''}});
 const hallData=data({hall:[],totals:{clicks:0,startedAt:0}});
 const on=async(path:string,live:LiveData=data())=>(await renderer.fetch(new Request('https://news.dev.pr'+path),live)).text();
 for(const [path,live] of [['/',data()],['/s/negocios',data()],['/search?q=luma',data()],['/story?id=1',storyData],['/archive',archiveData]] as [string,LiveData][])
  expect(await on(path,live)).toContain('id="alert-invite"');
 const env={DB:alertsDatabase()} as unknown as AlertEnv;
 const off=await Promise.all(['/signup','/stats','/comparar','/fuentes','/about','/hall','/s/no-existe'].map(async p=>[p,await on(p,p==='/hall'?hallData:data())] as [string,string]));
 for(const [path,html] of off){expect(html).not.toContain('id="alert-invite"');expect(html).not.toContain(invitationScript.slice(0,60));}
 // The private /alerts shell never carries the public invitation.
 const signin=await (await alertsRoute(new Request('https://news.dev.pr/alerts?lang=es'),env))!.text();
 expect(signin).not.toContain('id="alert-invite"');
 const confirmMiss=await (await alertsRoute(new Request('https://news.dev.pr/alerts/confirm?token=zz'),env))!.text();
 expect(confirmMiss).not.toContain('id="alert-invite"');
 for(const p of ['/alerts','/alerts/confirm','/alerts/watcher','/signup','/stats','/comparar','/fuentes','/about','/hall','/internal/refresh','/api/live','/feed','/sitemap.xml','/click?url=x'])
  expect(inviteEligible(p)).toBe(false);
});

it('ships one edition-independent script with the day math, delay, endpoint and quiet storage guards',()=>{
 expect(invitationScript).toContain(String(INVITE_DELAY_MS)); // modest reading delay before appearing
 expect(invitationScript).toContain(String(INVITE_VARIANT_COUNT)); // one round-robin over every variant
 expect(invitationScript).toContain(String(AST_UTC_OFFSET_MS)); // America/Puerto_Rico is AST (UTC-4) all year
 expect(invitationScript).toContain('Math.floor((Date.now()-'+AST_UTC_OFFSET_MS+')/86400000)'); // AST calendar day
 expect(invitationScript).toContain(INVITE_KEY); // local record: AST day + reason bit + shown index only
 expect(invitationScript).toContain('lang'); // edition-independent: switching language cannot reset it
 expect(invitationScript).toContain('/api/alerts-active');
 expect(invitationScript).toContain('localStorage'); // storage guarded...
 expect(invitationScript).toContain('sessionStorage'); // ...with a fallback and a quiet exit
 expect(invitationScript).not.toContain('cloudflareinsights'); // no new analytics of any kind
});

/* ------------------------------------------- client behavior (script harness) */

const DAY=86400000;
/** 16:00 UTC is noon AST (UTC-4, no DST in Puerto Rico). */
const NOON_AST=Date.UTC(2026,10,20,16,0,0);
function memoryStore(initial?:string|null){
 const m=new Map<string,string>();
 if(initial!=null)m.set(INVITE_KEY,initial);
 return {
  getItem:(k:string)=>m.has(k)?m.get(k)!:null,
  setItem:(k:string,v:string)=>{m.set(k,v)},
  removeItem:(k:string)=>{m.delete(k)}, // key-aware: the script's probe key never touches the record
  read:()=>m.get(INVITE_KEY)??null,
 };
}
const blockedStore=()=>{const boom=()=>{throw new Error('blocked')};return {getItem:boom,setItem:boom,removeItem:boom};};
interface FakeCard{hidden:boolean;listeners:Record<string,()=>void>;querySelector(sel:string):{addEventListener(ev:string,fn:()=>void):void}}
function inviteDom(){
 const cards:FakeCard[]=Array.from({length:INVITE_VARIANT_COUNT},()=>{
  const listeners:Record<string,()=>void>={};
  return {hidden:true,listeners,querySelector:(sel:string)=>({addEventListener:(ev:string,fn:()=>void)=>{listeners[sel+':'+ev]=fn}})};
 });
 const docListeners:Record<string,(e:{key:string})=>void>={};
 const box={hidden:true,removed:false,remove(){box.removed=true},querySelectorAll:(sel:string)=>sel==='.invite-card'?cards:[]};
 const doc={hidden:false,getElementById:(id:string)=>id==='alert-invite'?box:null,addEventListener:(ev:string,fn:(e:{key:string})=>void)=>{docListeners[ev]=fn},listeners:docListeners};
 return {box,cards,doc};
}
/** One page load: fresh DOM, current clock, the given local store, a scripted endpoint. */
async function runInvite(store:unknown,opts:{now:number,active?:boolean|'error'}){
 vi.setSystemTime(opts.now);
 vi.stubGlobal('localStorage',store);
 vi.stubGlobal('sessionStorage',blockedStore()); // no fallback: the primary store is the one under test
 let fetches=0;
 vi.stubGlobal('fetch',vi.fn(async()=>{
  if(fetches>0)return {ok:true,json:async()=>({})};
  fetches++;
  if(opts.active==='error')return Promise.reject(new Error('offline'));
  return {ok:true,json:async()=>({active:opts.active===true})};
 }));
 const dom=inviteDom();
 new Function('document',invitationScript)(dom.doc);
 await vi.advanceTimersByTimeAsync(INVITE_DELAY_MS);
 return {dom,fetches};
}
const shown=(dom:ReturnType<typeof inviteDom>)=>dom.cards.findIndex(c=>!c.hidden);

it('treats the America/Puerto_Rico day boundary as 04:00 UTC (AST, no DST)',()=>{
 expect(astDayKey(Date.UTC(2026,10,20,4,0,0)-1)).toBe(astDayKey(Date.UTC(2026,10,20,4,0,0))-1); // 23:59:59 vs 00:00:00 AST
 expect(astDayKey(Date.UTC(2026,10,20,3,59,59)+DAY)).toBe(astDayKey(Date.UTC(2026,10,20,3,59,59))+1); // any calendar day rolls the same way
 expect(astDayKey(NOON_AST)).toBe(astDayKey(Date.UTC(2026,10,20,3,59,59))+1);
});

it('reveals exactly one variant after the reading delay and records that AST day',async()=>{
 const store=memoryStore();
 const {dom,fetches}=await runInvite(store,{now:NOON_AST});
 expect(fetches).toBe(1); // the account check happens once per eligible display attempt
 expect(dom.box.hidden).toBe(false);
 expect(shown(dom)).toBe(0);
 expect(dom.cards.map(c=>c.hidden)).toEqual([false,true,true,true,true]); // one card, never a carousel
 expect(JSON.parse(store.read()!)).toEqual({d:astDayKey(NOON_AST),a:0,v:0});
});

it('suppresses every variant for the rest of the same AST day, across page loads, without touching the record',async()=>{
 const store=memoryStore();
 await runInvite(store,{now:NOON_AST});
 const sameDay=await runInvite(store,{now:NOON_AST+3600000});
 expect(sameDay.dom.box.hidden).toBe(true);
 expect(sameDay.fetches).toBe(0); // not even an account check: today is already used
 expect(JSON.parse(store.read()!)).toEqual({d:astDayKey(NOON_AST),a:0,v:0}); // a mere page load advances nothing
});

it('dismisses via the close button and the CTA without reopening that day',async()=>{
 const store=memoryStore();
 const first=await runInvite(store,{now:NOON_AST});
 first.dom.cards[0].listeners['.invite-close:click']();
 expect(first.dom.box.removed).toBe(true);
 const afterClose=await runInvite(store,{now:NOON_AST+60000});
 expect(afterClose.dom.box.hidden).toBe(true);
 const second=await runInvite(store,{now:NOON_AST+DAY});
 expect(shown(second.dom)).toBe(1); // next day: the NEXT variant
 second.dom.cards[1].listeners['.invite-cta:click'](); // following the CTA also uses up the day
 expect(second.dom.box.removed).toBe(true);
 const afterCta=await runInvite(store,{now:NOON_AST+DAY+60000});
 expect(afterCta.dom.box.hidden).toBe(true);
});

it('advances the deterministic round-robin across days and wraps around',async()=>{
 const store=memoryStore();
 for(let day=0;day<INVITE_VARIANT_COUNT+2;day++){
  const {dom}=await runInvite(store,{now:NOON_AST+day*DAY});
  expect(shown(dom)).toBe(day%INVITE_VARIANT_COUNT);
  expect(JSON.parse(store.read()!)).toEqual({d:astDayKey(NOON_AST+day*DAY),a:0,v:day%INVITE_VARIANT_COUNT});
 }
});

it('advances only on actual displays: an account-active day never moves the index',async()=>{
 const store=memoryStore();
 await runInvite(store,{now:NOON_AST}); // day 0: variant 0 shown
 const activeDay=await runInvite(store,{now:NOON_AST+DAY,active:true});
 expect(activeDay.dom.box.hidden).toBe(true); // signed-in browser with active alerts: suppressed
 expect(JSON.parse(store.read()!)).toEqual({d:astDayKey(NOON_AST+DAY),a:1,v:0}); // index preserved, not advanced
 const next=await runInvite(store,{now:NOON_AST+2*DAY});
 expect(shown(next.dom)).toBe(1); // the round-robin continues where it left off
});

it('honors the AST midnight boundary: no reopening while reading, next visit on a later day rotates',async()=>{
 // The day is evaluated when the display decision happens (visit + reading delay), and only
 // then — there is no midnight timer, so a page being read never reopens the invitation.
 const store=memoryStore();
 const beforeMidnight=Date.UTC(2026,10,20,3,59,30); // decision at 23:59:50 AST, Nov 19
 const first=await runInvite(store,{now:beforeMidnight});
 expect(shown(first.dom)).toBe(0);
 expect(JSON.parse(store.read()!)).toEqual({d:astDayKey(beforeMidnight+INVITE_DELAY_MS),a:0,v:0});
 const sameNight=await runInvite(store,{now:Date.UTC(2026,10,20,3,59,0)}); // decision at 23:59:20 AST
 expect(sameNight.dom.box.hidden).toBe(true); // still Nov 19 AST: suppressed
 const pastMidnight=await runInvite(store,{now:Date.UTC(2026,10,20,4,0,30)}); // decision at 00:00:50 AST, Nov 20
 expect(pastMidnight.fetches).toBe(1); // a later day: eligible again on the next visit, not via any timer
 expect(shown(pastMidnight.dom)).toBe(1);
});

it('keeps dismissal and rotation across edition switches: the record has no language',async()=>{
 const store=memoryStore();
 const es=await runInvite(store,{now:NOON_AST}); // Spanish edition display
 expect(shown(es.dom)).toBe(0);
 const en=await runInvite(store,{now:NOON_AST+60000}); // same browser, switched to English
 expect(en.dom.box.hidden).toBe(true); // same-day dismissal survives the switch
 const nextDay=await runInvite(store,{now:NOON_AST+DAY});
 expect(shown(nextDay.dom)).toBe(1); // and so does the rotation
 // Both editions embed the identical edition-independent script and key.
 const esHtml=await renderer.fetch(new Request('https://news.dev.pr/'),data()).text();
 const enHtml=await renderer.fetch(new Request('https://news.dev.pr/?lang=en'),data()).text();
 expect(esHtml).toContain(invitationScript);
 expect(enHtml).toContain(invitationScript);
 expect(esHtml).toContain(`store.getItem('${INVITE_KEY}')`);
 expect(enHtml).toContain(`store.getItem('${INVITE_KEY}')`);
});

it('stays quiet on storage errors and shows the invitation when the status check fails',async()=>{
 const blocked=await runInvite(blockedStore(),{now:NOON_AST});
 expect(blocked.dom.box.hidden).toBe(true); // no storage: silent, never a per-page nag
 expect(blocked.fetches).toBe(0);
 const store=memoryStore();
 const offline=await runInvite(store,{now:NOON_AST,active:'error'});
 expect(offline.dom.box.hidden).toBe(false); // endpoint failure is quiet for the visitor and does not block the invitation
 expect(JSON.parse(store.read()!)).toEqual({d:astDayKey(NOON_AST),a:0,v:0});
});

/* --------------------------------------------------- boolean status endpoint */

const MIGRATIONS=['0001_live.sql','0009_alerts.sql'];
function alertsDatabase() {
 const db=new DatabaseSync(':memory:');
 for(const name of MIGRATIONS)db.exec(readFileSync(`migrations/${name}`,'utf8'));
 const DB={prepare:(sql:string)=>{
  const chain=(...args:unknown[])=>({
   first:async()=>db.prepare(sql).get(...(args as any[]))??null,
   all:async()=>({results:db.prepare(sql).all(...(args as any[]))}),
   run:async()=>({meta:{changes:Number(db.prepare(sql).run(...(args as any[])).changes??0)}}),
  });
  return {bind:chain,first:chain().first,all:chain().all,run:chain().run};
 }} as unknown as D1Database;
 return DB;
}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const envWithSession=async()=>{
 const env={DB:alertsDatabase()} as unknown as AlertEnv;
 const now=Date.now();
 await env.DB.prepare("INSERT INTO alert_accounts(id,email,language,status,last_notification,out_hash,created_at) VALUES(?,?,?,?,?,?,?)")
  .bind('acc-1','reader@example.org','es','active',0,'out-hash-1',now).run();
 await env.DB.prepare('INSERT INTO alert_sessions(id,account_id,token_hash,csrf,created_at,expires_at) VALUES(?,?,?,?,?,?)')
  .bind('ses-1','acc-1',sha('session-secret-1'),'csrf-1',now,now+86400000).run();
 return env;
};
const addWatcher=(env:AlertEnv,status:string)=>env.DB.prepare('INSERT INTO alert_watchers(id,account_id,phrase,tokens,status,baseline,scan_cursor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
 .bind('w-'+status,'acc-1','Energía LUMA','[energia, luma]',status,Date.now(),Date.now(),Date.now(),Date.now()).run();
const cookie='alerts_session=session-secret-1';

it('answers one boolean bit for a signed-in browser with active alerts and nothing else',async()=>{
 const env=await envWithSession();
 const none=await alertsActiveRoute(new Request('https://news.dev.pr/api/alerts-active'),env);
 expect(none?.status).toBe(200);
 expect(none?.headers.get('Cache-Control')).toBe('no-store');
 expect(none?.headers.get('Set-Cookie')).toBeNull();
 expect(await none?.text()).toBe('{"active":false}');
 await addWatcher(env,'active');
 const active=await alertsActiveRoute(new Request('https://news.dev.pr/api/alerts-active',{headers:{Cookie:cookie}}),env);
 expect(active?.status).toBe(200);
 expect(active?.headers.get('Cache-Control')).toBe('no-store');
 expect(active?.headers.get('Set-Cookie')).toBeNull();
 const body=await active?.text();
 expect(body).toBe('{"active":true}'); // exactly one bit: never an email, a phrase or session data
 expect(body).not.toContain('reader@example.org');
 expect(body).not.toContain('LUMA');
 const head=await alertsActiveRoute(new Request('https://news.dev.pr/api/alerts-active',{method:'HEAD'}),env);
 expect(head?.status).toBe(200);
 expect(head?.headers.get('Cache-Control')).toBe('no-store');
 expect(await head?.text()).toBe('');
});

it('suppresses on active watchers only: paused accounts and missing or expired sessions answer false, and mutations are rejected',async()=>{
 const env=await envWithSession();
 await addWatcher(env,'paused');
 const paused=await alertsActiveRoute(new Request('https://news.dev.pr/api/alerts-active',{headers:{Cookie:cookie}}),env);
 expect(await paused?.text()).toBe('{"active":false}');
 await env.DB.prepare('INSERT INTO alert_watchers(id,account_id,phrase,tokens,status,baseline,scan_cursor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
  .bind('w-active-2','acc-1','aaa','[aaa]','active',0,0,Date.now(),Date.now()).run();
 const mixed=await alertsActiveRoute(new Request('https://news.dev.pr/api/alerts-active',{headers:{Cookie:cookie}}),env);
 expect(await mixed?.text()).toBe('{"active":true}');
 const expired={DB:alertsDatabase()} as unknown as AlertEnv;
 const now=Date.now();
 await expired.DB.prepare("INSERT INTO alert_accounts(id,email,language,status,last_notification,out_hash,created_at) VALUES(?,?,?,?,?,?,?)").bind('acc-2','x@example.org','es','active',0,null,now).run();
 await expired.DB.prepare('INSERT INTO alert_sessions(id,account_id,token_hash,csrf,created_at,expires_at) VALUES(?,?,?,?,?,?)')
  .bind('ses-2','acc-2',sha('expired-secret'),'csrf-2',now-1000,now-100).run();
 const stale=await alertsActiveRoute(new Request('https://news.dev.pr/api/alerts-active',{headers:{Cookie:'alerts_session=expired-secret'}}),expired);
 expect(await stale?.text()).toBe('{"active":false}');
 const post=await alertsActiveRoute(new Request('https://news.dev.pr/api/alerts-active',{method:'POST',body:''}),env);
 expect(post?.status).toBe(405);
 expect(post?.headers.get('Allow')).toBe('GET, HEAD');
 expect(await alertsActiveRoute(new Request('https://news.dev.pr/api/live'),env)).toBeUndefined(); // other paths untouched
});

it('keeps shared page HTML free of session state: a cookie changes nothing on a reading page',async()=>{
 vi.setSystemTime(NOON_AST);
 const fresh=():Item=>({...item('https://example.org/b'),time:NOON_AST});
 const bare=await renderer.fetch(new Request('https://news.dev.pr/'),{items:[fresh()],translations:{},feeds:[]}).text();
 const withCookie=await renderer.fetch(new Request('https://news.dev.pr/',{headers:{Cookie:cookie}}),{items:[fresh()],translations:{},feeds:[]}).text();
 expect(withCookie).toBe(bare); // one cached HTML for every visitor, invitation markup included
 expect(bare).toContain('id="alert-invite"');
});
it('accumulates across navigation, pauses hidden time, and emits each action once',async()=>{
 vi.setSystemTime(NOON_AST);
 const local=memoryStore(),session=memoryStore();
 vi.stubGlobal('localStorage',local);vi.stubGlobal('sessionStorage',session);
 const requests:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{requests.push(init?.body as string||url);return {ok:true,json:async()=>({active:false})}}));
 const first=inviteDom();new Function('document',invitationScript)(first.doc);
 await vi.advanceTimersByTimeAsync(6000);vi.clearAllTimers();vi.setSystemTime(NOON_AST+6000);
 const next=inviteDom();new Function('document',invitationScript)(next.doc);
 next.doc.hidden=true;next.doc.listeners.visibilitychange({key:''});
 await vi.advanceTimersByTimeAsync(60000);
 expect(next.box.hidden).toBe(true);
 next.doc.hidden=false;next.doc.listeners.visibilitychange({key:''});
 await vi.advanceTimersByTimeAsync(8750);expect(next.box.hidden).toBe(true);
 await vi.advanceTimersByTimeAsync(500);expect(next.box.hidden).toBe(false);
 next.cards[0].listeners['.invite-cta:click']();next.doc.listeners.keydown({key:'Escape'});
 expect(requests.filter(x=>x.includes('"event":"shown"'))).toHaveLength(1);
 expect(requests.filter(x=>x.includes('"event":"clicked"'))).toHaveLength(1);
 expect(requests.filter(x=>x.includes('dismissed'))).toHaveLength(0);
});

import {invitationEventRoute,invitationCounts} from '../src/invitation-events';
it('validates anonymous events and distinguishes absent migration from zero',async()=>{
 const db=alertsDatabase();expect(await invitationCounts({DB:db})).toBeNull();
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync('migrations/0017_invitation_events.sql','utf8'));
 const DB={prepare:(sql:string)=>{const chain=(...args:any[])=>({run:async()=>sqlite.prepare(sql).run(...args),first:async()=>sqlite.prepare(sql).get(...args),all:async()=>({results:sqlite.prepare(sql).all(...args)})});return {...chain(),bind:chain}}} as unknown as D1Database;
 expect(await invitationCounts({DB})).toMatchObject({shown:0,clicked:0,dismissed:0});
 const req=(body:unknown,origin='https://news.dev.pr')=>new Request('https://news.dev.pr/api/invitation-event',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const event={variant:0,lang:'es',event:'shown'};
 expect((await invitationEventRoute(req(event,'https://other.test'),{DB}))?.status).toBe(403);
 for(const invalid of [{...event,variant:5},{...event,email:'x'}, {...event,event:'visit'}])expect((await invitationEventRoute(req(invalid),{DB}))?.status).toBe(400);
 expect((await invitationEventRoute(req(event),{DB}))?.status).toBe(204);
 expect(await invitationCounts({DB})).toMatchObject({shown:1,clicked:0});
 const html=await renderer.fetch(new Request('https://news.dev.pr/stats?lang=en'),data({invitationStats:await invitationCounts({DB})})).text();
 expect(html).toContain('1 shown');expect(html).toContain('Events, not unique users');
});

function lifecyclePage(){
 const dom=inviteDom();
 const events:Record<string,(e:{persisted?:boolean})=>void>={};
 new Function('document','window',invitationScript)(dom.doc,{addEventListener:(name:string,fn:(e:{persisted?:boolean})=>void)=>{events[name]=fn}});
 return {dom,events,visibility(hidden:boolean){dom.doc.hidden=hidden;dom.doc.listeners.visibilitychange({key:''})}};
}
it('rehydrates shared reading progress when Back restores a cached page',async()=>{
 vi.setSystemTime(NOON_AST);
 vi.stubGlobal('localStorage',memoryStore());vi.stubGlobal('sessionStorage',memoryStore());
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({active:false})})));
 const a=lifecyclePage();await vi.advanceTimersByTimeAsync(6000);a.events.pagehide({});
 const b=lifecyclePage();await vi.advanceTimersByTimeAsync(6000);b.events.pagehide({});
 a.events.pageshow({persisted:true});
 await vi.advanceTimersByTimeAsync(2750);expect(a.dom.box.hidden).toBe(true);
 await vi.advanceTimersByTimeAsync(250);expect(a.dom.box.hidden).toBe(false);
});
it.each(['inactivity','midnight'])('invalidates deferred account checks after %s expiry',async(reason)=>{
 vi.setSystemTime(reason==='midnight'?Date.UTC(2026,10,20,3,59,40):NOON_AST);
 vi.stubGlobal('localStorage',memoryStore());vi.stubGlobal('sessionStorage',memoryStore());
 let resolve!:(value:unknown)=>void;
 const request=new Promise(r=>{resolve=r});
 vi.stubGlobal('fetch',vi.fn((url:string)=>url==='/api/alerts-active'?request:Promise.resolve({ok:true})));
 const p=lifecyclePage();await vi.advanceTimersByTimeAsync(INVITE_DELAY_MS);
 p.visibility(true);
 vi.setSystemTime(Date.now()+(reason==='midnight'?10000:1800001));
 resolve({ok:true,json:async()=>({active:false})});await vi.advanceTimersByTimeAsync(0);
 p.visibility(false);await vi.advanceTimersByTimeAsync(14750);expect(p.dom.box.hidden).toBe(true);
 await vi.advanceTimersByTimeAsync(250);expect(p.dom.box.hidden).toBe(false);
});
