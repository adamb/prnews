import { localUrl, type Language } from './i18n';

/** Proactive keyword-alert invitation on the public reading pages.
 *
 * Privacy posture (mirrors the rest of the site): the invitation markup ships inside the
 * shared, edge-cached page HTML and is identical for every visitor; the only personalization
 * happens in the browser — a local storage record (no cookies, no identifiers, no analytics)
 * and one same-origin boolean fetch. A signed-in browser that already has active alerts is
 * suppressed by `/api/alerts-active`, which answers exactly one bit and is always no-store,
 * so session state can never enter the shared HTML cache. A signed-out visitor who created
 * alerts elsewhere cannot be recognized, and nothing claims otherwise. All failures stay
 * quiet: with storage blocked the invitation never appears rather than nagging per page.
 *
 * Cadence and rotation: one invitation per calendar day in America/Puerto_Rico time (AST,
 * UTC-4 all year — no DST, so a fixed offset is exact). Showing, closing or following the
 * CTA suppresses every variant for the rest of that same AST day across all public pages;
 * the next eligible visit on a later day offers the NEXT variant in deterministic
 * round-robin. The variant index persists locally and advances only on an actual display —
 * never on plain page loads or on suppressed (account-active) checks, so rotation can never
 * make the invitation nag. There is no midnight timer: the day is evaluated per visit, so
 * nothing re-opens while a visitor is reading. The record key is edition-independent, so
 * switching Español/English never resets dismissal or rotation.
 *
 * Variants: a handful of bilingual invitations (company, name, favorite artist, town,
 * favorite topic) ship together in the page, all hidden; the client reveals exactly one
 * card per eligible display and it never changes while the reader is looking (no carousel). */

/** Local storage key for the record: { d: AST day number, a: 0|1 reason bit
 * (1 = suppressed because this session has active alerts), v: variant index last SHOWN }. */
export const INVITE_KEY = 'prnews-alert-invite';
/** Modest reading delay before the invitation appears. */
export const INVITE_DELAY_MS = 20000;
/** Puerto Rico is AST (UTC-4) all year; DST does not apply, so a fixed offset is exact. */
export const AST_UTC_OFFSET_MS = 4 * 3600000;
/** The America/Puerto_Rico calendar day of a moment, as a day number: the unit the
 * same-day dismissal and the day-to-day rotation are measured in. */
export function astDayKey(ms: number): number {
	return Math.floor((ms - AST_UTC_OFFSET_MS) / 86400000);
}

/** One bilingual invitation variant. The CTA and close label are shared so every card stays
 * coherent: each title names a thing to follow, each body says how alerts work with the
 * truthful batched-delivery wording (never an instant promise). */
export interface InviteVariant {
	es: { title: string; body: string };
	en: { title: string; body: string };
}
export const INVITE_VARIANTS: InviteVariant[] = [
	{
		es: { title: '¿Quieres saber cuándo mencionan tu empresa?', body: 'Crea alertas para tu empresa o los temas que te interesan y recibe las noticias que coincidan, en máximo un correo por hora.' },
		en: { title: 'Want to know when they mention your company?', body: 'Create alerts for your company or the topics you care about; matching stories arrive in at most one email per hour.' },
	},
	{
		es: { title: '¿Quieres saber cuándo sale tu nombre en las noticias?', body: 'Crea una alerta con tu nombre y recibe las noticias que lo mencionen, en máximo un correo por hora.' },
		en: { title: 'Want to know when your name shows up in the news?', body: 'Create an alert with your name and get the stories that mention it, at most one email per hour.' },
	},
	{
		es: { title: '¿Quieres saber cuándo hablan de tu artista favorito?', body: 'Crea una alerta con el nombre de tu artista favorito y recibe las noticias que lo mencionen, en máximo un correo por hora.' },
		en: { title: 'Want to know when your favorite artist makes the news?', body: 'Create an alert with your favorite artist’s name and get the stories that mention them, at most one email per hour.' },
	},
	{
		es: { title: '¿Quieres saber cuándo mencionan tu pueblo?', body: 'Crea una alerta con tu pueblo —San Juan, Ponce, Mayagüez…— y recibe las noticias que lo mencionen, en máximo un correo por hora.' },
		en: { title: 'Want to know when your town comes up?', body: 'Create an alert for your town —San Juan, Ponce, Mayagüez…— and get the stories that mention it, at most one email per hour.' },
	},
	{
		es: { title: '¿Hay un tema que quieras seguir de cerca?', body: 'Crea alertas para los temas que te interesan —política, deportes, música…— y recibe las noticias que coincidan, en máximo un correo por hora.' },
		en: { title: 'Is there a topic you want to follow?', body: 'Create alerts for the topics you care about —politics, sports, music…— and get the matching stories, at most one email per hour.' },
	},
];
/** Number of rotating variants; the client script and tests share this. */
export const INVITE_VARIANT_COUNT = INVITE_VARIANTS.length;
const inviteCta = { es: 'Crear mis alertas', en: 'Create my alerts' } as const;
const inviteClose = { es: 'Cerrar', en: 'Close' } as const;

/** Public reading routes where the invitation may appear. Utility and ranking pages
 * (/stats, /comparar, /fuentes, /about, /hall), the signup page itself, every /alerts*
 * page (session-scoped, no-store) and all non-200 responses are excluded. */
export function inviteEligible(pathname: string): boolean {
	if (pathname === '/' || pathname === '/story' || pathname === '/search' || pathname === '/archive') return true;
	return pathname.startsWith('/s/');
}

/** All variant cards, hidden by the server; the client script reveals exactly one. */
export function invitationHtml(lang: Language): string {
	const closeIcon = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2 2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
	const cards = INVITE_VARIANTS.map((variant, i) => {
		const c = variant[lang];
		return `<div class="invite-card" data-variant="${i}" hidden aria-labelledby="alert-invite-title-${i}"><button type="button" class="invite-close" aria-label="${inviteClose[lang]}">${closeIcon}</button><p class="invite-title" id="alert-invite-title-${i}">${c.title}</p><p class="invite-body">${c.body}</p><a class="invite-cta" href="${localUrl('/alerts', lang)}">${inviteCta[lang]}</a></div>`;
	}).join('');
	return `<aside class="invite" id="alert-invite" hidden>${cards}</aside>`;
}

/** Client logic, one inline script, edition-independent (the record key has no language, so
 * switching editions cannot reset it). Probe storage (localStorage, then sessionStorage; with
 * neither, stay silent), wait out the reading delay, then: one AST-day record suppresses
 * every variant for the rest of the day; otherwise ask the boolean endpoint whether this
 * browser's session already has active alerts, and only then reveal the next variant card,
 * persisting the shown index — the only thing that advances the rotation. No focus is
 * forced; Escape also closes; there is no midnight timer, only per-visit evaluation. */
export const invitationScript = `(function(){
var box=document.getElementById('alert-invite');if(!box)return;
var store;try{var p='__prnews-invite-probe';localStorage.setItem(p,p);localStorage.removeItem(p);store=localStorage}
catch(e){try{var q='__prnews-invite-probe';sessionStorage.setItem(q,q);sessionStorage.removeItem(q);store=sessionStorage}catch(e2){store=null}}
if(!store)return;
var N=${INVITE_VARIANT_COUNT};
function day(){return Math.floor((Date.now()-${AST_UTC_OFFSET_MS})/86400000)}
function read(){try{var v=store.getItem('${INVITE_KEY}');return v?JSON.parse(v):null}catch(e){return null}}
function save(a,v){try{store.setItem('${INVITE_KEY}',JSON.stringify({d:day(),a:a,v:v}))}catch(e){}}
function sameDay(rec){return !!rec&&rec.d===day()}
function shown(rec){return rec&&typeof rec.v==='number'&&rec.v>=0?rec.v:-1}
function reveal(v){
var r=read();if(sameDay(r))return; // another display already used today's slot
var cards=box.querySelectorAll('.invite-card');if(!cards.length)return;
for(var i=0;i<cards.length;i++)cards[i].hidden=i!==v;
save(0,v);if(box.hidden)box.hidden=false;
}
function show(){
var rec=read();if(sameDay(rec))return; // today's display already happened or was dismissed
var v=(shown(rec)+1)%N; // next variant: advances only when this display really happens
fetch('/api/alerts-active',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(j){
if(j&&j.active===true){save(1,shown(rec));return} // suppressed check never advances the rotation
reveal(v)}).catch(function(){reveal(v)}); // a failed check stays quiet and shows the invitation
}
setTimeout(function(){
if(document.hidden){document.addEventListener('visibilitychange',function h(){if(!document.hidden){document.removeEventListener('visibilitychange',h);show()}});return}
show();
},${INVITE_DELAY_MS});
function close(){box.remove()}
Array.prototype.forEach.call(box.querySelectorAll('.invite-card'),function(card){
var b=card.querySelector('.invite-close');if(b)b.addEventListener('click',close);
var c=card.querySelector('.invite-cta');if(c)c.addEventListener('click',close);
});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!box.hidden)close()});
})()`;
