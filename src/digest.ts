import {quarantined} from './quarantine';
import type { Item } from './parse';
import { safeUrl } from './parse';
import { translated, type Translation, type Language } from './i18n';
import { isEnglishSource, isEnglishItem } from './sources';
import { hash, getImportance } from './importance';
export interface DigestEnv { DB:D1Database; AI?:Ai; DIGEST_ENABLED?:string; RESEND_API_KEY?:string; IMPROVMX_API_KEY?:string; DIGEST_FROM?:string; DIGEST_TOKEN_SECRET?:string }
// IMPROVMX_API_KEY is intentionally unused: ImprovMX's shared transactional account prohibits
// newsletters, so the digest only ever sends through Resend. Its presence alone must never enable sending.
const ORIGIN='https://news.dev.pr', DAY=86400000;
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const configured=(e:DigestEnv)=>!!(e.DIGEST_ENABLED==='true' && e.RESEND_API_KEY?.trim() && e.DIGEST_FROM?.trim() && !/[\r\n]/.test(e.DIGEST_FROM) && (e.DIGEST_TOKEN_SECRET?.length??0)>=32);
const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
async function unsubscribeToken(env:DigestEnv,id:string) {
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.DIGEST_TOKEN_SECRET!),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('unsubscribe:'+id))),b=>b.toString(16).padStart(2,'0')).join('');
}
const link=(kind:string,token:string)=>`${ORIGIN}/digest/${kind}?token=${token}`;
interface SendResult { ok:boolean; throttled:boolean; ambiguous:boolean; rejection:boolean; retryAt:number }
/** Send one email through Resend. The stable idempotency key lets an ambiguous
 * outcome (network error, 5xx, timeout) be retried safely: within Resend's 24-hour
 * retention, a retried key returns the original response instead of mailing again. */
async function send(env:DigestEnv,to:string,key:string,body:{subject:string;html:string;text:string},unsubscribe:string,from=env.DIGEST_FROM!):Promise<SendResult> {
 try {
  const response=await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({from,to:[to],...body,headers:{'List-Unsubscribe':`<${unsubscribe}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}})});
  const retry=response.headers.get('Retry-After');
  const parsed=retry?(/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now()):0;
  const delay=Number.isFinite(parsed)&&parsed>0?parsed:0;
  await response.body?.cancel();
  if(response.ok) return {ok:true,throttled:false,ambiguous:false,rejection:false,retryAt:0};
  if(response.status===429) return {ok:false,throttled:true,ambiguous:false,rejection:false,retryAt:Date.now()+Math.max(60000,delay)};
  if(response.status>=500) return {ok:false,throttled:false,ambiguous:true,rejection:false,retryAt:Date.now()+Math.max(300000,delay)};
  // 4xx other than 429: the provider certainly rejected the request; nothing was accepted.
  return {ok:false,throttled:false,ambiguous:false,rejection:true,retryAt:0};
 } catch {
  // Timeout or connection loss: acceptance is unknown, so fall back and retry under the key.
  return {ok:false,throttled:false,ambiguous:true,rejection:false,retryAt:Date.now()+300000};
 }
}
const accepted={status:'accepted',message:'If eligible, a confirmation will arrive. / Si corresponde, recibirás una confirmación.'} as const;
/** Never reveal existence, suppression, rate limits, or provider failures to the caller. */
export async function subscribe(env:DigestEnv,email:string,language:Language='es',now=Date.now()) {
 if(!configured(env)) return {status:'unavailable',message:'Subscriptions temporarily unavailable. / Suscripciones no disponibles.'} as const;
 email=email.trim().toLowerCase();
 if(email.length>254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) || !['es','en'].includes(language)) return accepted;
 const day=Math.floor(now/DAY);
 const limit=await env.DB.prepare('INSERT INTO digest_limits(day,requests) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET requests=requests+1 WHERE requests<100 RETURNING requests').bind(day).first();
 if(!limit) return accepted;
 const id=crypto.randomUUID(),token=randomToken(),unsub=await unsubscribeToken(env,id);
 const row=await env.DB.prepare(`INSERT INTO digest_subscribers(id,email,language,confirm_hash,confirm_expires,unsubscribe_hash,last_request,request_day) VALUES(?,?,?,?,?,?,?,?)
 ON CONFLICT(email) DO UPDATE SET confirm_hash=excluded.confirm_hash,confirm_expires=excluded.confirm_expires,language=excluded.language,last_request=excluded.last_request,request_day=excluded.request_day,request_count=CASE WHEN request_day=excluded.request_day THEN request_count+1 ELSE 1 END
 WHERE status='pending' AND last_request<=? AND (request_day<>? OR request_count<3) RETURNING id,unsubscribe_hash`).bind(id,email,language,await hash(token),now+DAY,await hash(unsub),now,day,now-3600000,day).first<{id:string}>();
 if(!row) return accepted;
 const stop=link('unsubscribe',await unsubscribeToken(env,row.id)),confirm=link('confirm',token);
 await send(env,email,`confirm/${await hash(token)}`,{subject:'Confirma tu suscripción / Confirm your subscription',html:`<p><a href="${confirm}">Confirmar / Confirm</a> (24h)</p><p><a href="${stop}">Cancelar / Unsubscribe</a></p>`,text:`Confirmar / Confirm (24h): ${confirm}\nCancelar / Unsubscribe: ${stop}`},stop);
 return accepted;
}
export async function confirm(env:Pick<DigestEnv,'DB'>,token:string,now=Date.now()) {
 if(/^[a-f0-9]{64}$/.test(token)) await env.DB.prepare("UPDATE digest_subscribers SET status='active',confirmed_at=COALESCE(confirmed_at,?) WHERE confirm_hash=? AND confirm_expires>? AND status IN ('pending','active')").bind(now,await hash(token),now).run();
 return {status:'processed',message:'Confirmation processed. / Confirmación procesada.'};
}
export async function unsubscribe(env:Pick<DigestEnv,'DB'>,token:string) {
 if(/^[a-f0-9]{64}$/.test(token)) await env.DB.prepare("UPDATE digest_subscribers SET status='unsubscribed',confirm_hash=NULL WHERE unsubscribe_hash=?").bind(await hash(token)).run();
 return {status:'processed',message:'Unsubscribe processed. / Cancelación procesada.'};
}
export interface Story { es:Item; en:Item|null; importanceEs:string; importanceEn:string }
export function selectStories(items:Item[],cutoff:number,count=5):Item[] {
 const ordered=items.filter(i=>!quarantined(i.url) && i.time>cutoff-DAY && i.time<=cutoff && i.source!=='reddit_puertorico' && safeUrl(i.url)).sort((a,b)=>b.time-a.time || a.url.localeCompare(b.url));
 const selected:Item[]=[],seen=new Set<string>(),urls=new Set<string>();
 for(const diverse of [true,false]) for(const item of ordered) {
  if(selected.length>=count) break;
  if(urls.has(item.url) || (diverse && seen.has(item.source))) continue;
  selected.push(item); seen.add(item.source); urls.add(item.url);
 }
 return selected;
}
export function renderDigest(stories:Story[],_language:Language,stop:string) {
 const title='El resumen de la isla';
 const sections=(['es','en'] as const).map(language=>{
  const lines=stories.flatMap(s=>{const i=language==='en'?s.en:s.es;return i?[{item:i,why:language==='en'?s.importanceEn:s.importanceEs}]:[];});
  const heading=language==='en'?'English':'Español';
  return {html:`<section lang="${language}"><h2>${heading}</h2>${lines.map(({item:i,why})=>`<article><h3><a href="${escape(safeUrl(i.url))}">${escape(i.title)}</a></h3><p>${escape(i.source)}</p><p>${escape(i.summary.slice(0,300))}</p>${why?`<p>${language==='en'?'Why it matters':'Por qué importa'}: ${escape(why)}</p>`:''}</article>`).join('') || '<p>Translations updating… / Traducciones en actualización…</p>'}</section>`,text:heading+'\n'+lines.map(({item:i,why})=>`${i.title}\n${i.source}\n${i.summary.slice(0,300)}\n${why}\n${safeUrl(i.url)}`).join('\n\n')};
 });
 return {subject:title,html:`<h1>${title}</h1>${sections.map(s=>s.html).join('')}<p><a href="${escape(stop)}">Cancelar suscripción / Unsubscribe</a></p>`,text:`${title}\n\n${sections.map(s=>s.text).join('\n\n')}\n\nCancelar suscripción / Unsubscribe: ${stop}`};
}
/** Invoke at 10:30 UTC, then retry bounded batches against the same cutoff. */
export async function runDigest(env:DigestEnv,cutoff=Date.now(),batchSize=25) {
 if(!configured(env)) return {status:'unavailable'};
 const day=new Date(cutoff).toISOString().slice(0,10);
 let snapshot=await env.DB.prepare('SELECT * FROM digest_days WHERE day=?').bind(day).first<{stories:string;cutoff:number;sender:string}>();
 if(!snapshot) {
  const rows=await env.DB.prepare('SELECT payload,translation FROM articles WHERE published_at>? AND published_at<=? ORDER BY published_at DESC LIMIT 300').bind(cutoff-DAY,cutoff).all<{payload:string;translation:string|null}>();
  const cache:Record<string,Translation>={}; const items=rows.results.map(r=>{const i=JSON.parse(r.payload) as Item;if(r.translation) cache[i.url]=JSON.parse(r.translation);return i;});
  const stories:Story[]=[];
  for(const i of selectStories(items,cutoff)) {
   const en=translated(i,'en',cache),es=translated(i,'es',cache);
   const english=isEnglishItem(i)||en.translated?en:null;
   stories.push({es,en:english,importanceEs:(await getImportance(env,es.summary)).text,importanceEn:english?(await getImportance(env,english.summary)).text:''});
  }
  if(!stories.length) return {status:'empty'};
  await env.DB.prepare('INSERT OR IGNORE INTO digest_days(day,cutoff,stories,sender) VALUES(?,?,?,?)').bind(day,cutoff,JSON.stringify(stories),env.DIGEST_FROM!).run();
  snapshot=(await env.DB.prepare('SELECT * FROM digest_days WHERE day=?').bind(day).first<typeof snapshot>())!;
 }
 await env.DB.prepare(`INSERT OR IGNORE INTO digest_deliveries(day,subscriber,language) SELECT ?,id,language FROM digest_subscribers s WHERE status='active' AND confirmed_at<=? AND NOT EXISTS (SELECT 1 FROM digest_deliveries d WHERE d.day=? AND d.subscriber=s.id) ORDER BY id LIMIT 50`).bind(day,snapshot.cutoff,day).run();
 // 'sending' rows with an expired lease are crash recovery; legacy 'uncertain' rows predate idempotent retries and resume the same way.
 const rows=await env.DB.prepare(`SELECT d.subscriber,d.language FROM digest_deliveries d JOIN digest_subscribers s ON s.id=d.subscriber WHERE d.day=? AND d.state IN ('pending','uncertain','sending') AND d.lease_until<? AND d.attempts<5 AND s.status='active' LIMIT ?`).bind(day,Date.now(),Math.max(1,Math.min(50,batchSize))).all<{subscriber:string;language:Language}>();
 let sent=0;
 for(const row of rows.results) {
  const now=Date.now();
  const claim=await env.DB.prepare(`UPDATE digest_deliveries SET state='sending',lease_until=?,attempts=attempts+1,first_attempt=COALESCE(first_attempt,?) WHERE day=? AND subscriber=? AND state IN ('pending','uncertain','sending') AND lease_until<? AND attempts<5 AND (first_attempt IS NULL OR first_attempt>?) RETURNING subscriber`).bind(now+90000,now,day,row.subscriber,now,now-23*3600000).first();
  if(!claim) continue;
  const subscriber=await env.DB.prepare("SELECT email FROM digest_subscribers WHERE id=? AND status='active'").bind(row.subscriber).first<{email:string}>();
  if(!subscriber) continue;
  const stop=link('unsubscribe',await unsubscribeToken(env,row.subscriber));
  const result=await send(env,subscriber.email,`digest/${day}/${row.subscriber}`,renderDigest(JSON.parse(snapshot.stories),row.language,stop),stop,snapshot.sender);
  // Accepted → sent. 429 → back to pending at Retry-After without consuming an attempt; stop the batch.
  // Ambiguous (5xx/network) → back to pending with a backoff lease; the idempotency key keeps retries duplicate-free.
  // Definite 4xx rejection → terminal 'failed'; identical payloads will never be accepted.
  await env.DB.prepare("UPDATE digest_deliveries SET state=?,sent_at=?,lease_until=?,attempts=attempts-? WHERE day=? AND subscriber=?").bind(result.ok?'sent':result.rejection?'failed':'pending',result.ok?Date.now():null,result.ok||result.rejection?0:result.retryAt,result.throttled?1:0,day,row.subscriber).run();
  if(result.ok) sent++;
  if(result.throttled) break;
 }
 return {status:'processed',sent,examined:rows.results.length};
}

export function eligibleDigestCutoff(now:number) {
 const today=Date.parse(new Date(now).toISOString().slice(0,10)+'T10:30:00Z');
 return now>=today?today:today-DAY;
}
