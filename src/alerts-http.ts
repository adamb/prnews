/**
 * HTTP routes for keyword alerts. All /alerts* pages and endpoints: no-store, no-indexing,
 * no referrers, no analytics beacon, and no tokens in URLs after single-use redemption.
 * Security posture:
 *  - Public abuse endpoints (/alerts/signup, /alerts/signin): Cloudflare Turnstile server-side
 *    verification plus a honeypot, global daily caps and same-origin enforcement. When the
 *    Turnstile secret or site key is missing, these endpoints are truthfully disabled — there
 *    is never an unprotected public email endpoint.
 *  - Confirm/sign-in/manage links are single-use, expiring, hashed-at-rest magic tokens and
 *    immediately rotate into a session cookie, then redirect to a clean URL.
 *  - Responses reveal nothing about whether an address exists. They also stay honest about
 *    transport state: a blocked cross-origin submission and a failed anti-abuse challenge
 *    each return their own clear localized retry guidance (nothing recorded, no implied
 *    account state) instead of a generic "if eligible" fake success — while the generic
 *    response is kept for account-specific outcomes after a valid challenge.
 *  - Same-origin enforcement compares the canonical origin (scheme + host + port, plus
 *    browser-asserted Sec-Fetch-Site evidence for null/rewritten-scheme posts); manage
 *    mutations additionally run under a scoped session cookie (HttpOnly, SameSite=Lax,
 *    Secure on https), a per-session CSRF token, and per-account ownership scoping.
 */
import {
	subscribe, confirm, requestSignin, useMagicLink, sessionFromCookie, listWatchers, manageWatcher,
	closeByUnsubscribeHash, closeAccount, ALERTS_COOKIE, type AlertEnv, type Verdict,
} from './alerts';
import { turnstileRenderConfigured, turnstileWidget, turnstileCspSource } from './turnstile';
import { faviconLinks } from './favicon';
import { copyrightNotice } from './copyright';
import { css } from './styles';
import { FONT_PATH } from './font';
import { englishSections, localUrl } from './i18n';
import { navigationSections, primarySection } from './sections';

/** Same two inline scripts as the public masthead. Hashes are the CSP allow-list; no other
 * inline script is added. The public analytics beacon, /api/live refresh, and satire script
 * are not part of this shell. */
export const alertThemeBoot = `try{const t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}`;
export const alertThemeToggle = `document.getElementById('theme').addEventListener('click',()=>{const root=document.documentElement;const dark=root.dataset.theme?root.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;root.dataset.theme=dark?'light':'dark';try{localStorage.setItem('theme',root.dataset.theme)}catch{}})`;
export const alertThemeBootHash = '/5MU3+Sn2wW+1ppkEzASs4rkzWlgs3j0KJwiU66Uum0=';
export const alertThemeToggleHash = '/9gL5Mdhol6R9U/BmC/9a8pTxTY6xnChaLGu1nfLb+I=';
const themeSources = `'sha256-${alertThemeBootHash}' 'sha256-${alertThemeToggleHash}'`;
const CSP_FORM = `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; script-src https://challenges.cloudflare.com ${turnstileCspSource} ${themeSources}; frame-src https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
const CSP_PLAIN = `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; script-src ${themeSources}; base-uri 'none'; frame-ancestors 'none'`;
/** Page-only rules. The shared sheet already carries the masthead, type, color, button, and footer. */
const alertExtras = `.alerts-page{max-width:720px}.alerts-page .row{margin:14px 0}.alerts-page label{display:grid;gap:6px;font-weight:600}.alerts-page input[type=email],.alerts-page input[type=text]{width:100%;padding:12px;border-radius:4px;background:var(--bg);color:var(--ink);border:1px solid var(--line)}.alerts-page .muted{color:var(--muted);font-size:14px}.signed-in{overflow-wrap:anywhere}.banner{background:var(--soft);border-left:3px solid var(--accent);padding:12px 14px;margin:0 0 16px;color:var(--ink)}.watcher{border-top:1px solid var(--line);padding:18px 0;overflow-wrap:anywhere}.watcher-edit{margin:12px 0}.watcher-edit summary{cursor:pointer;width:fit-content;min-height:44px;padding:8px 0}.watcher-edit summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.watcher-edit[open] summary{font-weight:600}.actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px}.alerts-page .actions a{min-height:44px;display:inline-flex;align-items:center}.account-actions{display:flex;flex-wrap:wrap;gap:12px;margin:8px 0 18px}.cf-turnstile{margin:12px 0}.alerts-page h1{margin-top:0}@media(max-width:390px){.alerts-page{max-width:none}.account-actions,.account-actions form,.account-actions button,.alerts-page .row button{width:100%}.actions{gap:8px}}`;
type Language = 'es' | 'en';
const translate = (lang: Language) => (es: string, en: string) => lang === 'en' ? en : es;

const base = (headers: Record<string, string> = {}, csp = CSP_PLAIN) => ({
	'Content-Type': 'text/html; charset=utf-8',
	'Cache-Control': 'no-store',
	'Referrer-Policy': 'no-referrer',
	'Content-Security-Policy': csp,
	'X-Robots-Tag': 'noindex, nofollow',
	...headers,
});

const searchIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>';
const themeIcon = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor"/></svg>';

function render(title: string, body: string, options: { lang: Language; status?: number; headers?: Record<string, string>; csp?: string }): Response {
	const lang = options.lang;
	const t = translate(lang);
	const home = localUrl('/', lang);
	const alertsHref = localUrl('/alerts', lang);
	const sectionName = (slug: string, name: string) => lang === 'en' ? englishSections[primarySection(slug)] ?? name : navigationSections.find(([s]) => s === primarySection(slug))?.[1] ?? name;
	const sectionLink = (slug: string, name: string, extra = '') => `<a ${extra}href="${localUrl('/s/' + slug, lang)}">${sectionName(slug, name)}</a>`;
	const contact = 'prnews@code.pr';
	const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex, nofollow"><title>${title} · news.dev.pr</title>${faviconLinks}<link rel="preload" href="${FONT_PATH}" as="font" type="font/woff2" crossorigin><style>${css}${alertExtras}</style><script>${alertThemeBoot}</script></head><body><a class="skip" href="#contenido">${t('Ir al contenido', 'Skip to content')}</a><header class="wrap masthead"><div><a class="brand" href="${home}">news<b>.dev.pr</b></a><div class="tagline">${t('Noticias de Puerto Rico', 'Puerto Rico News')}</div></div><div class="mast-tools"><form class="header-search" action="/search" method="get" role="search"><input type="hidden" name="lang" value="${lang}"><label class="visually-hidden" for="site-search">${t('Buscar noticias', 'Search news')}</label><label class="search-open" for="site-search" aria-hidden="true">${searchIcon}</label><div><input id="site-search" name="q" type="search" maxlength="200" placeholder="${t('Buscar noticias…', 'Search news…')}"><button type="submit" aria-label="${t('Buscar noticias', 'Search news')}">${searchIcon}</button></div></form><a class="alerts-link" href="${alertsHref}" aria-current="page">${t('Mis alertas', 'My alerts')}</a><a class="alerts-link" href="${localUrl('/sugerir', lang)}">${t('Sugerir', 'Suggest')}</a><nav class="languages" aria-label="${t('Idioma', 'Language')}"><a href="${localUrl('/alerts', 'es')}" lang="es" hreflang="es" aria-current="${lang === 'es'}">Español</a><a href="${localUrl('/alerts', 'en')}" lang="en" hreflang="en" aria-current="${lang === 'en'}">English</a></nav><button id="theme" type="button" aria-label="${t('Cambiar tema claro u oscuro', 'Toggle light or dark theme')}" title="${t('Cambiar tema claro u oscuro', 'Toggle light or dark theme')}">${themeIcon}</button></div></header><nav class="nav" aria-label="${t('Secciones', 'Sections')}"><div class="wrap navrow"><div class="tabs"><a href="${home}">${t('Portada', 'Top Stories')}</a>${navigationSections.slice(0, 3).map(([slug, name]) => sectionLink(slug, name)).join('')}</div><details class="more-nav"><summary>${t('Más secciones', 'More sections')}</summary><div>${navigationSections.slice(0, 3).map(([slug, name]) => sectionLink(slug, name, 'class="narrow-only" ')).join('')}${navigationSections.slice(3).map(([slug, name]) => sectionLink(slug, name)).join('')}<a class="alerts-sheet" href="${alertsHref}" aria-current="page">${t('Mis alertas', 'My alerts')}</a><a class="alerts-sheet" href="${localUrl('/sugerir', lang)}">${t('Sugerir fuente', 'Suggest a source')}</a></div></details></div></nav><main id="contenido" class="wrap"><div class="alerts-page"><h1>${title}</h1>${body}<p><a href="https://news.dev.pr/?lang=${lang}">${t('Volver', 'Back')}</a></p></div></main><footer><div class="wrap digest-footer"><div><h2><a href="${localUrl('/signup', lang)}">${t('Alertas por palabra clave', 'Keyword alerts')}</a></h2><p>${t('Recibe por correo las noticias que coinciden con tu frase; sin contraseñas y máximo un correo por hora. ', 'Get email matches for your phrase; passwordless, at most one email per hour. ')}<a href="${alertsHref}">${t('Mis alertas', 'My alerts')}</a></p></div></div><div class="wrap"><span>${copyrightNotice(lang)}</span><div class="links"><a href="${localUrl('/archive', lang)}">${t('Archivo', 'Archive')}</a><a href="${localUrl('/fuentes', lang)}">${t('Fuentes', 'Sources')}</a><a href="${localUrl('/sugerir', lang)}">${t('Sugerir fuente', 'Suggest a source')}</a><a href="${localUrl('/stats', lang)}">${t('Estadísticas', 'Stats')}</a><a href="${localUrl('/comparar', lang)}">${t('Medios', 'Outlets')}</a><a href="${localUrl('/hall', lang)}">${t('Salón de la fama', 'Hall of fame')}</a><a href="${localUrl('/about', lang)}">${t('Acerca de', 'About')}</a><a href="mailto:${contact}">${contact}</a><a href="/feed">RSS</a></div></div></footer><script>${alertThemeToggle}</script></body></html>`;
	return new Response(html, { status: options.status ?? 200, headers: base(options.headers, options.csp ?? CSP_PLAIN) });
}
const result = (lang: Language, message: string, status = 200) => render(translate(lang)('Alertas', 'Alerts'), `<p>${message}</p>`, { lang, status });

/** Same explanation for every valid email-only request; never disclose account state. */
function signinResult(lang: Language): Response {
 const t = translate(lang);
 return result(lang, `${t('Si ya creaste una alerta, revisa tu correo para el enlace de acceso o de confirmación. Si tienes una confirmación vigente, usa ese correo anterior: no enviamos otra copia.', 'If you previously created an alert, check your email for a sign-in or confirmation link. If a confirmation is still valid, use that earlier email; we do not send another copy.')}</p><p><a href="/signup?lang=${lang}">${t('¿Primera vez? Crea una alerta con tu correo y una palabra clave.', 'First time? Create an alert with your email and a keyword.')}</a>`, 202);
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** Retry-page retention: normalize whitespace, cap the length, THEN escape — user input is
 * echoed back only inside fully escaped quoted attributes and can break out of nothing. */
const retained = (value: string | undefined, cap: number) => escapeHtml((value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, cap));

/** Honest failure for a blocked mutation: the submission arrived from another origin. It
 * says nothing about the address and nothing was recorded; the visitor gets the canonical
 * form location instead of a fake success that causes endless retries. */
function blockedOriginPage(lang: 'es' | 'en', surface: '/signup' | '/alerts'): Response {
	const es = lang !== 'en';
	const t = (a: string, b: string) => es ? a : b;
	const body = `<p class="banner">${t('El envío se detuvo en la verificación de origen: llegó desde una página o dominio distinto de este sitio, así que se descartó y no se registró nada.', 'Your submission stopped at the origin check: it arrived from a page or domain other than this site, so it was discarded and nothing was recorded.')}</p><p><a href="${surface}${lang === 'en' ? '?lang=en' : ''}">${t('Abre el formulario aquí y envíalo desde esta misma página.', 'Open the form here and submit it from this same page.')}</a></p><p class="muted">${t('Si estás en un visor integrado (previsualizaciones o apps), copia este enlace y ábrelo en tu navegador.', 'If you are in an embedded viewer (previews or apps), copy this link and open it in your browser.')}</p>`;
	return render(t('Alertas', 'Alerts'), body, { lang, status: 403 });
}

/** Honest captcha failure: challenge missing, expired, failed or network interruption — it
 * happens before any database access, so it reveals nothing about the address. The form is
 * re-rendered with a fresh challenge and the user's retained (escaped) input, capped before
 * escaping. When the widget cannot render at all, point back to the paused-forms page. */
function captchaRetryPage(env: AlertEnv, lang: 'es' | 'en', surface: 'signup' | 'signin', email: string, phrase: string): Response {
	const es = lang !== 'en';
	const t = (a: string, b: string) => es ? a : b;
	const banner = t('No pudimos verificar tu envío: el desafío antiabuso faltaba, venció o falló (también puede ser una interrupción de red). No se registró nada; tus datos están abajo, revísalos y vuelve a enviar.', 'We could not verify your submission: the anti-abuse challenge was missing, expired, or failed (possibly a network interruption). Nothing was recorded; your details are below — review them and submit again.');
	const publicOk = turnstileRenderConfigured(env);
	const backHref = `${surface === 'signup' ? '/signup' : '/alerts'}${lang === 'en' ? '?lang=en' : ''}`;
	if (!publicOk) return render(t('Alertas', 'Alerts'), `<p class="banner">${banner}</p><p><a href="${backHref}">${t('Abrir el formulario.', 'Open the form.')}</a></p>`, { lang, status: 400 });
	const honeypot = `<input type="text" name="x_presencia" value="" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;height:0;width:0">`;
	const phraseField = surface === 'signup'
		? `<div class="row"><label>${t('Palabra o frase', 'Keyword or phrase')} <input type="text" name="phrase" required maxlength="120" value="${phrase}"></label></div>`
		: '';
	const action = surface === 'signup' ? '/alerts/signup' : '/alerts/signin';
	const note = t('Este aviso se refiere solo al desafío antiabuso; no dice nada sobre tu correo.', 'This notice is about the anti-abuse challenge only; it says nothing about your email address.');
	const form = `<form method="post" action="${action}${lang === 'en' ? '?lang=en' : ''}"><input type="hidden" name="lang" value="${lang}">${honeypot}<div class="row"><label>${t('Correo electrónico', 'Email')} <input type="email" name="email" required maxlength="254" autocomplete="email" value="${email}"></label></div>${phraseField}${turnstileWidget(env.TURNSTILE_SITE_KEY!, surface)}<div class="row"><button type="submit">${t('Enviar de nuevo', 'Submit again')}</button></div></form><p class="muted">${note}</p>`;
	return render(t('Alertas', 'Alerts'), `<p class="banner">${banner}</p>${form}`, { lang, status: 400, csp: CSP_FORM });
}

function redirect(url: string, cookie?: string): Response {
	const headers = { Location: url, ...base({}, CSP_PLAIN) };
	return new Response(null, { status: 303, headers: cookie ? { ...headers, 'Set-Cookie': cookie } : headers });
}

function sessionCookie(request: Request, secret: string, maxAge: number): string {
	const https = new URL(request.url).protocol === 'https:' || (request.headers.get('X-Forwarded-Proto') ?? '').includes('https');
	return `${ALERTS_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
}
const dropCookie = (request: Request) => sessionCookie(request, '', 0);

const cookieValue = (request: Request, name: string): string | undefined => {
	const header = request.headers.get('Cookie');
	if (!header) return undefined;
	for (const part of header.split(/;\s*/)) {
		const eq = part.indexOf('=');
		if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
	}
	return undefined;
};
const sameOriginGate = (request: Request): { allow: boolean; why: string } => {
	/** Canonical same-origin gate for every mutation route. Origin identity is scheme + host +
	 * port: a rewritten scheme (http page, terminating proxy) or a different port is a
	 * different origin and is rejected — no proxy behaviour is assumed. The one override is
	 * Sec-Fetch-Site, a forbidden header only a browser can set, which may vouch for the
	 * sender even when Origin is absent, 'null' (sandboxed/webview posts), or scheme-rewritten;
	 * a sibling host on the site's own zone (e.g. www.news.dev.pr) needs that same
	 * browser-asserted evidence. Without any origin evidence the request is treated as before
	 * — Turnstile, the honeypot and the caps still gate it there. Rejections are classified
	 * for logs only: raw Origin/Referer values (which can carry paths or query strings) are
	 * never logged. */
	const secFetch = (request.headers.get('Sec-Fetch-Site') ?? '').trim().toLowerCase();
	const parts = (value: string) => {
		try { const u = new URL(value.trim()); return { origin: u.origin.toLowerCase(), host: u.hostname.toLowerCase(), port: u.port, https: u.protocol === 'https:' }; }
		catch { return undefined; }
	};
	const target = new URL(request.url);
	const targetOrigin = target.origin.toLowerCase();
	const targetSelf = target.hostname.toLowerCase() === 'news.dev.pr' || target.hostname.toLowerCase().endsWith('.news.dev.pr');
	if (secFetch === 'cross-site') return { allow: false, why: 'sec-fetch=cross-site' };
	const origin = request.headers.get('Origin');
	if (origin !== null) {
		if (origin.trim().toLowerCase() === 'null') return { allow: secFetch === 'same-origin', why: `origin=null sec-fetch=${secFetch || 'absent'}` };
		const from = parts(origin);
		if (!from) return { allow: secFetch === 'same-origin', why: `origin=invalid sec-fetch=${secFetch || 'absent'}` };
		if (from.origin === targetOrigin) return { allow: true, why: 'self' };
		// Scheme rewritten but same host+port: only browser-asserted fetch metadata vouches.
		if (from.host === target.hostname.toLowerCase() && from.port === target.port && secFetch === 'same-origin')
			return { allow: true, why: 'scheme-rewritten sec-fetch=same-origin' };
		if (targetSelf && (from.host === 'news.dev.pr' || from.host.endsWith('.news.dev.pr')) && (secFetch === 'same-origin' || secFetch === 'same-site'))
			return { allow: true, why: 'site-alias sec-fetch=' + secFetch };
		return { allow: false, why: `origin=foreign scheme=${from.https ? 'https' : from.origin.startsWith('http') ? 'http' : 'other'} sec-fetch=${secFetch || 'absent'}` };
	}
	if (secFetch === 'same-origin') return { allow: true, why: 'origin=absent sec-fetch=same-origin' };
	const referer = request.headers.get('Referer') ? parts(request.headers.get('Referer')!) : undefined;
	if (referer) {
		if (referer.origin === targetOrigin) return { allow: true, why: 'origin=absent referer=self' };
		if (targetSelf && (referer.host === 'news.dev.pr' || referer.host.endsWith('.news.dev.pr')) && secFetch === 'same-site')
			return { allow: true, why: 'origin=absent referer=site-alias' };
		return { allow: false, why: 'origin=absent referer=foreign' };
	}
	return { allow: true, why: 'no-origin-evidence' };
};
const timedEqual = (a: string, b: string) => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
};

async function readForm(request: Request): Promise<Record<string, string> | undefined> {
	const reader = request.body?.getReader();
	const decoder = new TextDecoder();
	let size = 0, text = '';
	if (reader) while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > 8192) { await reader.cancel(); return undefined; }
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	const type = request.headers.get('Content-Type') ?? '';
	if (type && !type.includes('form')) return undefined;
	return Object.fromEntries(new URLSearchParams(text));
}

const ipOf = (request: Request) => request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? null;

/* ------------------------------------------------------------------ pages */

function signinPage(env: AlertEnv, lang: 'es' | 'en'): Response {
	const es = lang !== 'en';
	const t = (a: string, b: string) => es ? a : b;
	const publicOk = turnstileRenderConfigured(env);
	const widget = publicOk ? turnstileWidget(env.TURNSTILE_SITE_KEY!, 'signin') : '';
	const form = publicOk
		? `<form method="post" action="/alerts/signin?lang=${lang}"><input type="hidden" name="lang" value="${lang}"><input type="text" name="x_presencia" value="" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;height:0;width:0"><div class="row"><label>${t('Correo electrónico', 'Email')} <input type="email" name="email" required maxlength="254" autocomplete="email"></label></div>${widget}<div class="row"><button type="submit">${t('Enviarme un enlace', 'Email me a link')}</button></div></form>`
		: `<p>${t('El acceso de nuevo ingreso está pausado temporalmente. No se aceptan solicitudes de enlaces hasta que se restablezca la verificación. Si ya tienes alertas activas, siguen funcionando.', 'New sign-ins are temporarily paused. Link requests are not accepted until verification is restored. If you already have active alerts, they keep working.')}</p>`;
	return render(t('Mis alertas', 'My alerts'), `<p class="muted">${t('Para acceder a una alerta que ya creaste, ingresa tu correo. Si todavía no lo confirmaste, puedes recuperar la confirmación aquí. No necesitas escribir de nuevo tus palabras clave.', 'To access an alert you already created, enter your email. If you have not confirmed it yet, you can recover your confirmation here. You do not need to enter your keywords again.')}</p>${form}<p class="muted"><a href="/signup?lang=${lang}">${t('¿Primera vez? Crea una alerta por palabra clave.', 'First time? Create a keyword alert.')}</a></p>`, { lang, csp: CSP_FORM });
}

function managePage(email: string, lang: 'es' | 'en', csrf: string, watchers: { id: string; phrase: string; tokens: string; status: string; created_at: number }[]): Response {
	const es = lang !== 'en';
	const t = (a: string, b: string) => es ? a : b;
	const cap = 10;
	const canAdd = watchers.length < cap;
	const rows = watchers.map(w => {
		const paused = w.status === 'paused';
		const toggleAction = paused ? 'resume' : 'pause';
		const phrase = escapeHtml(w.phrase);
		const fields = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="id" value="${escapeHtml(w.id)}">`;
		return `<section class="watcher"><div class="phrase"><strong>${phrase}</strong> <span class="muted">${paused ? t('· pausada', '· paused') : t('· activa', '· active')}</span></div><details class="watcher-edit"><summary>${t('Editar', 'Edit')}</summary><form method="post" action="/alerts/watcher?lang=${lang}">${fields}<input type="hidden" name="action" value="edit"><div class="row"><label>${t('Editar frase', 'Edit phrase')} <input type="text" name="phrase" maxlength="120" required value="${phrase}"></label></div><div class="actions"><button type="submit">${t('Guardar cambios', 'Save changes')}</button><a href="/alerts?lang=${lang}">${t('Cancelar', 'Cancel')}</a></div></form></details><form class="actions" method="post" action="/alerts/watcher?lang=${lang}">${fields}<button type="submit" name="action" value="${toggleAction}">${paused ? t('Reactivar', 'Resume') : t('Pausar', 'Pause')}</button><button type="submit" name="action" value="delete">${t('Eliminar', 'Delete')}</button></form></section>`;
	}).join('');
	const html = `<p class="signed-in">${t('Sesión iniciada como', 'Signed in as')} <strong>${escapeHtml(email)}</strong></p><p class="muted">${t('Recibes máximo un correo por hora con las noticias que coinciden con tus frases, en titulares y extractos, originales o traducidos.', 'You get at most one email per hour with stories matching your phrases, in headlines and excerpts, original or translated.')}</p>${canAdd ? `<h2>${t('Añadir una alerta nueva', 'Add a new alert')}</h2><p>${t('Crear una alerta aquí selecciona la edición original para todos tus próximos correos. Puede incluir originales en inglés.', 'Creating an alert here selects English for all your future alert batches. Stories await validated English translations.')}</p><form class="add-alert" method="post" action="/alerts/watcher?lang=${lang}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="add"><div class="row"><label>${t('Palabra o frase', 'Keyword or phrase')} <input type="text" name="phrase" maxlength="120" required placeholder="${t('p. ej. Act 60', 'e.g. Act 60')}"></label></div><div class="row"><button type="submit">${t('Crear alerta', 'Create alert')}</button></div></form>` : `<p class="muted">${t('Alcanzaste el máximo de alertas activas.', 'You reached the maximum number of alerts.')}</p>`}<h2>${t('Tus alertas', 'Your alerts')}</h2>${rows || `<p>${t('Todavía no tienes alertas. Crea una arriba.', 'You have no alerts yet. Create one above.')}</p>`}<div class="account-actions"><form method="post" action="/alerts/pauseall?lang=${lang}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">${t('Pausar todas', 'Pause all')}</button></form><form method="post" action="/alerts/unsubscribeall?lang=${lang}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">${t('Cancelar todas mis alertas', 'Unsubscribe from all')}</button></form></div><p class="muted">${t('Las fechas de activación evitan que frases nuevas juzguen noticias viejas.', 'Activation watermarks keep new phrases from judging old stories.')}</p>`;
	return render(t('Mis alertas', 'My alerts'), html, { lang, csp: CSP_FORM });
}

/* ------------------------------------------------------------------ router */

export async function alertsRoute(request: Request, env: AlertEnv): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.pathname !== '/alerts' && !url.pathname.startsWith('/alerts/')) return undefined;
	if (request.method === 'HEAD') return new Response(null, { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' } });
	let lang: Language = url.searchParams.get('lang') === 'en' ? 'en' : 'es';
	const t = (es: string, en: string) => translate(lang)(es, en);
	const ip = ipOf(request);
	try {
		/* ---- public abuse endpoints ---- */
		if (url.pathname === '/alerts/signup' && request.method !== 'POST')
			return result(lang, t('Usa el formulario en /signup.', 'Use the form at /signup.'), 405);
		if (url.pathname === '/alerts/signin' && request.method !== 'POST') {
			if (request.method === 'GET') return redirect(`/alerts?lang=${lang}`);
			return result(lang, t('Método no permitido.', 'Method not allowed.'), 405);
		}
		if (url.pathname === '/alerts/signup' && request.method === 'POST') {
			const origin = sameOriginGate(request);
			if (!origin.allow) { console.error('alerts_gate same-origin /alerts/signup ' + origin.why); return blockedOriginPage(lang, '/signup'); }
			const form = await readForm(request);
			if (!form) { console.error('alerts_gate unreadable-form', url.pathname); return result(lang, t('Solicitud no válida.', 'Invalid request.'), 400); }
			if (!url.searchParams.has('lang')) lang = form.lang === 'en' ? 'en' : 'es';
			const verdict: Verdict = await subscribe(env, {
				email: form.email ?? '', phrase: form.phrase ?? '', language: lang, captcha: form['cf-turnstile-response'], honeypot: (form['x_presencia'] || form.company || form.website || '').trim(), ip,
			});
			if (verdict.status === 'invalid-email') return result(lang, `${t('Ingresa un correo válido.', 'Enter a valid email address.')} <a href="/signup?lang=${lang}">${t('Reintentar', 'Try again')}</a>`, 400);
			if (verdict.status === 'invalid-phrase') return result(lang, `${t('Máximo 120 caracteres; incluye una palabra de 2–48 letras o números, p. ej. Act 60.', 'Maximum 120 characters; include a word of 2–48 letters or numbers, e.g. Act 60.')} <a href="/signup?lang=${lang}">${t('Reintentar', 'Try again')}</a>`, 400);
			if (verdict.status === 'unavailable') return result(lang, t('El servicio de alertas no está disponible temporalmente.', 'The alerts service is temporarily unavailable.'), 503);
			if (verdict.status === 'captcha-retry') return captchaRetryPage(env, lang, 'signup', retained(form.email, 254), retained(form.phrase, 120));
			return result(lang, t('Si corresponde, recibirás un correo. Revisa tu bandeja.', 'If eligible, an email will arrive; check your inbox.'), 202);
		}
		if (url.pathname === '/alerts/signin' && request.method === 'POST') {
			const origin = sameOriginGate(request);
			if (!origin.allow) { console.error('alerts_gate same-origin /alerts/signin ' + origin.why); return blockedOriginPage(lang, '/alerts'); }
			const form = await readForm(request);
			if (!form) return result(lang, t('Solicitud no válida.', 'Invalid request.'), 400);
			if (!url.searchParams.has('lang')) lang = form.lang === 'en' ? 'en' : 'es';
			const verdict = await requestSignin(env, { email: form.email ?? '', language: lang, captcha: form['cf-turnstile-response'], honeypot: (form['x_presencia'] || form.company || form.website || '').trim(), ip });
			if (verdict.status === 'invalid-email') return result(lang, `${t('Ingresa un correo válido.', 'Enter a valid email address.')} <a href="/alerts?lang=${lang}">${t('Reintentar', 'Try again')}</a>`, 400);
			if (verdict.status === 'unavailable') return result(lang, t('El servicio de alertas no está disponible temporalmente.', 'The alerts service is temporarily unavailable.'), 503);
			if (verdict.status === 'captcha-retry') return captchaRetryPage(env, lang, 'signin', retained(form.email, 254), '');
			return signinResult(lang);
		}
		/* ---- one-time token redemption pages ---- */
		if (url.pathname === '/alerts/confirm' && request.method === 'GET') {
			const outcome = await confirm(env, url.searchParams.get('token') ?? '');
			if (outcome.status === 'confirmed') return redirect(`/alerts?lang=${lang}`, sessionCookie(request, outcome.session.secret, Math.floor((outcome.session.expiresAt - Date.now()) / 1000)));
			const session = await sessionFromCookie(env, cookieValue(request, ALERTS_COOKIE));
			if (session) return redirect(`/alerts?lang=${lang}`);
			return render(t('Alertas', 'Alerts'), `<p>${t('Este enlace no abrió una sesión: puede haber vencido, haberse usado o estar incompleto. Este mensaje no confirma la activación de tus alertas.', 'This link did not open a session: it may be expired, already used, or incomplete. This message does not confirm that your alerts are active.')}</p><p><a href="/alerts?lang=${lang}">${t('Mis alertas', 'My alerts')}</a> — ${t('Solicita un enlace de acceso o recupera tu confirmación por correo, sin contraseña.', 'Request a sign-in link or recover your confirmation by email, without a password.')}</p>`, { lang });
		}
		if ((url.pathname === '/alerts/in' || url.pathname === '/alerts/m') && request.method === 'GET') {
			const purpose = url.pathname === '/alerts/in' ? 'signin' : 'manage';
			const outcome = await useMagicLink(env, url.searchParams.get('token') ?? '', purpose);
			if (outcome.status === 'session') return redirect(`/alerts?lang=${lang}`, sessionCookie(request, outcome.session.secret, Math.floor((outcome.session.expiresAt - Date.now()) / 1000)));
			return result(lang, t('Enlace no válido, vencido o ya usado. Solicita uno nuevo.', 'Link invalid, expired, or already used.'));
		}
		/* ---- unsubscribe capability (GET for mail clients is deliberate; POST identical) ---- */
		if (url.pathname === '/alerts/out' && ['GET', 'POST'].includes(request.method)) {
			await closeByUnsubscribeHash(env, url.searchParams.get('token') ?? '');
			return result(lang, t('Baja procesada.', 'Unsubscribe processed.'));
		}
		/* ---- session-scoped manage ---- */
		if (url.pathname === '/alerts') {
			if (request.method !== 'GET') return result(lang, t('Método no permitido.', 'Method not allowed.'), 405);
			const session = await sessionFromCookie(env, cookieValue(request, ALERTS_COOKIE));
			if (!session) return signinPage(env, lang);
			const watchers = await listWatchers(env, session.account_id);
			return managePage(session.email, lang, session.csrf, watchers);
		}
		if (url.pathname === '/alerts/signin' && request.method === 'GET') return redirect(`/alerts?lang=${lang}`);
		if (['/alerts/watcher', '/alerts/pauseall', '/alerts/unsubscribeall'].includes(url.pathname) && request.method === 'POST') {
			const origin = sameOriginGate(request);
			if (!origin.allow) { console.error('alerts_gate same-origin manage ' + origin.why); return result(lang, t('Solicitud no válida.', 'Invalid request.'), 403); }
			const session = await sessionFromCookie(env, cookieValue(request, ALERTS_COOKIE));
			if (!session) return result(lang, t('Sesión vencida. Inicia sesión de nuevo.', 'Session expired. Sign in again.'), 401);
			const form = await readForm(request);
			if (!form || !timedEqual(form.csrf ?? '', session.csrf)) return result(lang, t('Solicitud no válida.', 'Invalid request.'), 403);
			const now = Date.now();
			if (url.pathname === '/alerts/unsubscribeall') {
				await closeAccount(env, session.account_id);
				return redirect(`/alerts?lang=${lang}`, dropCookie(request));
			}
			if (url.pathname === '/alerts/pauseall') {
				await manageWatcher(env, session.account_id, 'pauseall', '', '');
				return redirect(`/alerts?lang=${lang}`);
			}
			const action = (form.action ?? '') as 'add' | 'edit' | 'pause' | 'resume' | 'delete';
			const outcome = ['add', 'edit', 'pause', 'resume', 'delete', 'pauseall'].includes(action)
				? await manageWatcher(env, session.account_id, action, (form.id ?? '').slice(0, 64), form.phrase ?? '', now, lang)
				: 'invalid';
			if (outcome === 'invalid') return redirect(`/alerts?lang=${lang}&error=1`);
			return redirect(`/alerts?lang=${lang}`);
		}
		return result(lang, t('Página no encontrada.', 'Page not found.'), 404);
	} catch {
		return result(lang, t('Actualizando… Intenta de nuevo pronto.', 'Updating… Please try again shortly.'), 503);
	}
}

/** Boolean-only companion for the public reading-page invitation script: does this browser's
 * alert session have at least one active watcher? The response carries exactly that bit —
 * never an email, a phrase, or session material — and is always no-store, so it can never
 * enter the shared HTML cache or the edge. A request without a valid session answers the
 * same false a signed-out visitor gets; no account state is revealed either way. */
export async function alertsActiveRoute(request: Request, env: AlertEnv): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.pathname !== '/api/alerts-active') return undefined;
	if (request.method !== 'GET' && request.method !== 'HEAD')
		return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
	const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
	try {
		const session = await sessionFromCookie(env, cookieValue(request, ALERTS_COOKIE));
		const row = session
			? await env.DB.prepare("SELECT 1 AS one FROM alert_watchers WHERE account_id=? AND status='active' LIMIT 1").bind(session.account_id).first<{ one: number }>()
			: null;
		return new Response(request.method === 'HEAD' ? null : JSON.stringify({ active: Boolean(row) }), { headers });
	} catch {
		return new Response('{"error":"unavailable"}', { status: 503, headers: { ...headers, 'Retry-After': '30' } });
	}
}
