import {lighterRoute,read as readLighter} from './lighter';
import {attachStoryIds, lighterCacheReadable, readLighterLedger, readLighterQueue, readySnapshot, type LighterView} from './lighter-stats';
import {sampleQueue,queueHistory} from './stats';
import {clicksBySource} from './source-compare';
import {attachThemeStoryIds, buildRecurringThemes, type ThemeReport} from './recurring-themes';
import { searchArticles } from './search';
import { clickRoute, topClicked, cleanupClicks, hallOfFame, cumulativeTop, totalClicks, type ClickEnv } from './trending';
import { refreshWebAnalytics, webAnalyticsSnapshot } from './analytics';
import { syndicationRoute, storyLookup } from './syndication';
import { alertsRoute, alertsActiveRoute } from './alerts-http';
import { runAlertSweep, confirmedAlertAccountCounts, type AlertEnv } from './alerts';
import { turnstileRenderConfigured } from './turnstile';
import { digestRoute } from './digest-http';
import { eligibleDigestCutoff, runDigest, configured as digestConfigured } from './digest';
import renderer, { noticeText, detailText } from './render';
import { faviconRoute } from './favicon';
import { fontRoute } from './font';
import { currentItem } from './current-item';
import { serveArchiveImage, archiveImages } from './archive';
import { discovery } from './discovery';
import { refresh, type Env, type FeedState } from './ingest';
import type { Item } from './parse';
import { needsTranslation, type Translation } from './i18n';
/** Serves a Cache-API stored page without the platform's browser-TTL stamp: the dev.pr zone applies
 * browser_cache_ttl=14400 to stored-hit headers (observed live: hits served `max-age=14400` while
 * origin says 60), and one such response lets a visitor's browser hold a stale render for hours.
 * Every HTML response this worker emits — origin or cache hit — must carry the origin freshness. */
export function serveBounded(cached: Response): Response {
 const headers=new Headers(cached.headers);
 headers.set('Cache-Control','public, max-age=60');
 headers.delete('content-length');
 return new Response(cached.body,{status:cached.status,headers});
}
export default {
 async scheduled(event: ScheduledController, env: Env): Promise<void> {
  if(event.cron==='30 10 * * *') {await runDigest(env,event.scheduledTime);return;}
  await refresh(env);
  // Satire is POST /api/lighter only. This job must not spend the daily model cap.
  await sampleQueue(env).catch(()=>{});
  await cleanupClicks(env).catch(()=>{});
  // Bounded Web Analytics refresh: at most one GraphQL read per TTL, only when stale.
  await refreshWebAnalytics(env).catch(()=>{});
  // Keyword alerts: match against the just-refreshed articles, batch and send, bounded.
  await runAlertSweep(env as unknown as AlertEnv,event.scheduledTime).catch(()=>{});
  const now=event.scheduledTime;
  const cutoff=eligibleDigestCutoff(now);
  // Continue bounded batches and retry transient sends using the same daily snapshot.
  if(now>=cutoff && now<cutoff+23*3600000)await runDigest(env,cutoff);
 },
 async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  try {
  const alerts=env.DB?await alertsRoute(request,env as unknown as AlertEnv):undefined;
  if(alerts)return alerts;
  // Boolean-only alert-account status for the reading-page invitation: no-store, never cached,
  // and the only account-derived byte it can answer is {active:true|false}.
  const alertsActive=env.DB?await alertsActiveRoute(request,env as unknown as AlertEnv):undefined;
  if(alertsActive)return alertsActive;
  const digest=await digestRoute(request,env);
  if(digest)return digest;
  // Public signup needs server-side Turnstile (secret + site key + hostname allowlist);
  // missing any piece pauses the UI truthfully — never an unprotected public email form.
  const alertsData=turnstileRenderConfigured(env)?{available:true,siteKey:env.TURNSTILE_SITE_KEY}:{available:false};
  const syndication=env.DB?await syndicationRoute(request,env):undefined;
  if(syndication)return syndication;
  const metadata = discovery(request);
  if(metadata) return metadata;
  const url=new URL(request.url);
  // Legacy language control retired: the old "English only" checkbox (?english=1) was the only
  // other way to shape a page besides ?lang=en, and when it survived an edition switch it left a
  // Spanish UI filtered to English-readable stories — the confusing mix visitors reported.
  // Canonicalize page URLs instead of honoring it: english=1 means the visitor wanted English-
  // readable stories, so 301 to ?lang=en (preserving q, source, page and any other params); any
  // other stray english flag is simply dropped (302). The header Español/English toggle is now
  // the single language control. Non-page routes (/click, /api/live, alerts, digest, ...) never
  // read this param and are left untouched.
  const pagePath=['/','/search','/story','/archive','/hall','/stats','/comparar','/fuentes','/about','/signup'].includes(url.pathname)||url.pathname.startsWith('/s/');
  if(pagePath&&(request.method==='GET'||request.method==='HEAD')&&url.searchParams.has('english')) {
   const one=url.searchParams.get('english')==='1';
   const target=new URL(url);
   target.searchParams.delete('english');
   if(one){
    // Deterministic canonical form: language leads the query for stable redirect targets.
    const rest=new URLSearchParams(target.search);
    rest.delete('lang');
    const encoded=rest.toString();
    target.search=encoded?`lang=en&${encoded}`:'lang=en';
   }
   return new Response(null,{status:one?301:302,headers:{Location:target.pathname+target.search}});
  }
  // Freshness payload for the in-page live refresh: browsers are allowed to cache rendered HTML
  // briefly, so the visible banner/queue numbers are re-fetched with cache:'reload' on every view.
  // Counts use the same unified needsTranslation definition and the same 14-day window as /stats.
  if(url.pathname==='/api/live') {
   if(!env.DB||(request.method!=='GET'&&request.method!=='HEAD'))return new Response('Not found',{status:404});
   try {
    const lang=url.searchParams.get('lang')==='en'?'en':'es';
    const rows=await env.DB.prepare('SELECT payload,translation FROM articles WHERE published_at>=? ORDER BY published_at DESC LIMIT 10000').bind(Date.now()-14*86400000).all<{payload:string;translation:string|null}>();
    const feeds=(await env.DB.prepare('SELECT last_ok FROM feed_state').all<{last_ok:number|null}>()).results;
    const translations:Record<string,Translation>={};
    const items=rows.results.map(row=>{
     const item=currentItem(JSON.parse(row.payload) as Item);
     if(row.translation)try{translations[item.url]=JSON.parse(row.translation) as Translation;}catch{/* Counts as awaiting translation. */}
     return item;
    });
    const pending=items.filter(i=>needsTranslation(i,translations));
    const cached=pending.filter(i=>translations[i.url]).length;
    const none=pending.length-cached;
    const payload={asOf:Date.now(),lastOk:feeds.some(f=>f.last_ok)?Math.max(0,...feeds.map(f=>f.last_ok??0)):0,pending:pending.length,none,invalid:cached,notice:{es:noticeText('es',feeds,pending.length),en:noticeText('en',feeds,pending.length)},detail:{es:detailText('es',none,cached),en:detailText('en',none,cached)}};
    return new Response(request.method==='HEAD'?null:JSON.stringify(payload),{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
   } catch(error) {
    console.error('live_error',String(error));
    return new Response('{"error":"unavailable"}',{status:503,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Retry-After':'30'}});
   }
  }
  // Site icon routes before the renderer: they work with or without D1, like /fallback.svg.
  const icon=faviconRoute(request);
  if(icon)return icon;
  // Display font for the front end: static, so it never waits on D1 or the page cache.
  const font=fontRoute(request);
  if(font)return font;
  if(url.pathname==='/fallback.svg')return new Response(request.method==='HEAD'?null:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#e8eee6"/><g fill="none" stroke="#68736c" stroke-width="7"><rect x="234" y="90" width="172" height="180" rx="8"/><path d="M260 125h120M260 155h120M260 185h50M330 185h50M260 215h50M330 215h50M260 245h120"/></g></svg>`,{headers:{'Content-Type':'image/svg+xml','Cache-Control':'public, max-age=86400'}});
  if(url.pathname.startsWith('/archive/images/')) return serveArchiveImage(request,env);
  if(url.pathname==='/internal/refresh'||url.pathname==='/internal/archive') {
   if(request.method!=='POST'||!env.REFRESH_TOKEN||request.headers.get('Authorization')!==`Bearer ${env.REFRESH_TOKEN}`) return new Response('Not found',{status:404});
   return Response.json(url.pathname==='/internal/archive'?await archiveImages(env):await refresh(env));
  }
  if(!env.DB) return renderer.fetch(request,undefined,digestConfigured(env));
  const satire=await lighterRoute(request,env);
  if(satire)return satire;
  const click=await clickRoute(request,env);
  if(click)return click;
  if(url.pathname==='/search') {
   const result=await searchArticles(env,{q:url.searchParams.get('q')??'',source:url.searchParams.get('source')??'',english:url.searchParams.get('lang')==='en',page:Number(url.searchParams.get('page')??1)});
   return renderer.fetch(request,{alerts:alertsData,items:result.items,translations:result.translations,feeds:[],search:result,contactEmail:env.CONTACT_EMAIL},digestConfigured(env));
  }
  if(url.pathname==='/story') {
   const raw=url.searchParams.get('id')??'';
   const story=await storyLookup(env,raw);
   // Saved satire state for this one page. read() already swallows a missing cache.
   const lighter=story?await readLighter(env):{};
   const storyIds:Record<string,number>={};
   if(story&&/^[1-9]\d{0,8}$/.test(raw))storyIds[story.item.url]=Number(raw);
   return renderer.fetch(request,{alerts:alertsData,items:story?[story.item]:[],translations:story?.translation?{[story.item.url]:story.translation}:{},feeds:[],story:true,lighter,storyIds,contactEmail:env.CONTACT_EMAIL},digestConfigured(env));
  }
  if(url.pathname==='/archive') {
   const date=url.searchParams.get('date')??'';
   const before=Number(url.searchParams.get('before')??Number.MAX_SAFE_INTEGER);
   if((date && (!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))))||!Number.isSafeInteger(before)||before<1)return new Response('Invalid archive filter',{status:400});
   const windowStart=Date.now()-14*86400000;
   const requestedStart=date?Date.parse(date+'T00:00:00-04:00'):windowStart;
   const start=Math.max(windowStart,requestedStart);
   const end=date?requestedStart+86400000:Number.MAX_SAFE_INTEGER;
   const result=await env.DB.prepare(`SELECT r.id,r.url,r.payload,r.translation,r.captured_at,r.image_url,i.object_key,i.error,i.attempts
    FROM archive_revisions r LEFT JOIN archive_images i ON i.url=r.image_url
    WHERE r.id<? AND r.captured_at>=? AND r.captured_at<? ORDER BY r.id DESC LIMIT 31`).bind(before,start,end).all<any>();
   const rows=result.results.slice(0,30),translations:Record<string,Translation>={};
   const items=rows.map(row=>{
    const item=JSON.parse(row.payload) as Item;
    // Key by revision as well as URL so two historic titles can each retain their translation.
    if(row.translation)translations[String(row.id)]=JSON.parse(row.translation);
    return {...item,image:row.object_key?'https://news.dev.pr/archive/'+row.object_key:''};
   });
   return renderer.fetch(request,{alerts:alertsData,items,translations,feeds:[],contactEmail:env.CONTACT_EMAIL,archive:{rows,next:result.results.length>30?rows[rows.length-1].id:null,date}},digestConfigured(env));
  }
  // Hall of fame: archived (>14 days old) articles ranked by lifetime recorded clicks.
  if(url.pathname==='/hall'&&env.DB) {
   try {
    const entries=await hallOfFame(env).catch(()=>[]);
    const historyTotals=await totalClicks(env).catch(()=>({clicks:0,startedAt:0}));
    return renderer.fetch(request,{alerts:alertsData,items:[],translations:{},feeds:[],hall:entries,totals:historyTotals,contactEmail:env.CONTACT_EMAIL},digestConfigured(env));
   } catch(error) {
    console.error('hall_error',String(error));
    return new Response('Actualizando… / Updating… Please try again shortly.',{status:503,headers:{'Retry-After':'60','Cache-Control':'no-store'}});
   }
  }
  // v38 drops v37 pages whose share/preview copy still said "AI joke, not news"
  // / "Chiste de IA, no noticia". The preview prefix, the share text tail and the
  // page's share script all carry the new wording.
  // v37 drops v36 pages that lack the keyword-alert invitation on reading routes.
  // v36 drops v35 pages whose share script cannot attach an open satire line.
  // v35 drops v34 pages that lack hreflang and canonical, and filtered pages that
  // were still indexable. v34 dropped v33 pages whose source names are not links
  // and that have no active-source chip. Compact imageless-lead rules and lighter-2
  // stay. 60s TTL still applies. This does not purge R2 or D1.
  const cache = typeof caches !== 'undefined' && request.method === 'GET' ? await caches.open('prnews-html-v38') : undefined;
  const cacheUrl = new URL(url.pathname, url.origin);
  cacheUrl.searchParams.set('lang', url.searchParams.get('lang') === 'en' ? 'en' : 'es');
  for(const key of ['source','q'])if(url.searchParams.has(key))cacheUrl.searchParams.set(key,url.searchParams.get(key)!);
  cacheUrl.searchParams.set('page', url.searchParams.get('page') ?? '1');
  const cacheKey = new Request(cacheUrl);
  const cached = await cache?.match(cacheKey);
  if(cached) return serveBounded(cached);
  try {
   const rows=await env.DB.prepare('SELECT a.payload AS payload,a.translation AS translation,s.id AS story_id FROM articles a LEFT JOIN story_ids s ON s.url=a.url WHERE a.published_at>=? ORDER BY a.published_at DESC LIMIT 10000').bind(Date.now()-14*86400000).all<{payload:string;translation:string|null;story_id:number|null}>();
   const feeds=await env.DB.prepare('SELECT * FROM feed_state').all<FeedState>();
   const translations:Record<string,Translation>={};
   const storyIds:Record<string,number>={};
   const items=rows.results.map(row=>{
    const item=JSON.parse(row.payload) as Item;
    if(row.translation)try{translations[item.url]=JSON.parse(row.translation) as Translation;}catch{/* Row still renders untranslated. */}
    const id=Number(row.story_id);
    if(Number.isSafeInteger(id)&&id>0)storyIds[item.url]=id;
    return item;
   });
   const trending=url.pathname==='/'?await topClicked(env).catch(()=>[]):[];
   const history=url.pathname==='/stats'?await queueHistory(env).catch(()=>undefined):undefined;
   // Lifetime click ledger + cached Web Analytics snapshot: D1-only reads, never API calls per view.
   const totals=url.pathname==='/stats'?await totalClicks(env).catch(()=>undefined):undefined;
   const popular=url.pathname==='/stats'?await cumulativeTop(env).catch(()=>[]):[];
   const analytics=url.pathname==='/stats'?await webAnalyticsSnapshot(env).catch(()=>undefined):undefined;
   const alertAccounts=url.pathname==='/stats'?await confirmedAlertAccountCounts(env):undefined;
   const sourceClicks=url.pathname==='/comparar'?await clicksBySource(env):undefined;
   const pageNow=Date.now();
   let recurringThemes:ThemeReport|undefined;
   if(url.pathname==='/comparar'){
    recurringThemes=buildRecurringThemes(items,pageNow);
    await attachThemeStoryIds(env,recurringThemes);
   }
   const lighter=await readLighter(env);
   let lighterView:LighterView|undefined;
   if(url.pathname==='/stats'){
    const ready=readySnapshot(items,lighter,await lighterCacheReadable(env));
    if(ready.available)await attachStoryIds(env,ready.examples);
    lighterView={ledger:await readLighterLedger(env),queue:await readLighterQueue(env,Date.now()),ready};
   }
   const response = renderer.fetch(request,{lighter,lighterView,alerts:alertsData,history,items,translations,feeds:feeds.results,trending,contactEmail:env.CONTACT_EMAIL,totals,popular,analytics,alertAccounts,sourceClicks,now:pageNow,recurringThemes,storyIds},digestConfigured(env));
   if(response.status === 200) {
    response.headers.set('Cache-Control','public, max-age=60');
    // CDN-Cache-Control pins the edge TTL too, in case a zone Cache Rule ever overrides it.
    response.headers.set('CDN-Cache-Control','public, max-age=60');
    if(cache && ctx) ctx.waitUntil(cache.put(cacheKey,response.clone()));
   }
   return response;
  } catch(error) {
   console.error('read_error',String(error));
   return new Response('Actualizando… / Updating… Please try again shortly.',{status:503,headers:{'Retry-After':'60','Cache-Control':'no-store'}});
  }
  } catch {return new Response('Actualizando… / Updating… Please try again shortly.',{status:503,headers:{'Retry-After':'60','Cache-Control':'no-store'}});}
 }
};
