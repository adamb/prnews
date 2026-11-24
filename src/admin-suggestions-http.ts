/**
 * HTTP routes for the owner-only source-suggestions dashboard: /admin (sign-in), /admin/signin,
 * /admin/in, /admin/signout, /admin/suggestions (+ /status, /delete, .csv). Unlisted and
 * private: no public page links here, every response is no-store, no-index, no-referrer,
 * nosniff, and nothing ever reveals whether a given address is the owner's.
 * Security posture (mirrors src/alerts-http.ts and src/suggestions-http.ts):
 *  - The sign-in request endpoint runs the same same-origin gate, a honeypot, an 8 KiB body
 *    cap and Cloudflare Turnstile server-side verification. When the Turnstile triangle or
 *    the mail provider is missing, the form is truthfully paused — never an unprotected form.
 *  - Magic-link redemption is two-step and scanner-safe: the GET link renders only a no-store
 *    confirmation page whose POST form carries the token, and a successful redemption
 *    303-redirects to the clean dashboard URL so the session never rides the address bar.
 *  - Every manage mutation (sign-out, status, delete) runs under the /admin-scoped session
 *    cookie (HttpOnly, SameSite=Lax, Secure on https) with a per-session CSRF token compared
 *    in constant time; the CSV export is session-gated as well.
 *  - Every suggestion field is HTML-escaped before it is rendered, only inside fully escaped
 *    quoted attributes. Submitter emails render as mailto links so the owner sees who sent
 *    each suggestion.
 */
import {
	ADMIN_COOKIE, adminSessionFromCookie, deleteSuggestion, exportSuggestionsCsv, listSuggestions,
	publicAdminConfigured, redeemAdminToken, requestAdminSignin, signOutAdmin, updateSuggestionStatus,
	type AdminSession, type AdminSuggestionRow, type SuggestionStatus,
} from './admin-suggestions';
import type { SuggestionEnv, SuggestionKind } from './suggestions';
import { turnstileRenderConfigured, turnstileWidget, turnstileCspSource } from './turnstile';
import { alertThemeBoot, alertThemeToggle, alertThemeBootHash, alertThemeToggleHash } from './alerts-http';
import { faviconLinks } from './favicon';
import { copyrightNotice } from './copyright';
import { css } from './styles';
import { FONT_PATH } from './font';
import { englishSections, localUrl } from './i18n';
import { navigationSections, primarySection } from './sections';

type Language = 'es' | 'en';
const translate = (lang: Language) => (es: string, en: string) => lang === 'en' ? en : es;
/** Field caps mirrored from the backend and the form maxlength attributes: email 254,
 * admin note 500, search query 100, row id 64 (UUIDs are 36). */
const EMAIL_CAP = 254, NOTE_CAP = 500, QUERY_CAP = 100, ID_CAP = 64;
/** Dashboard page size; listSuggestions() clamps 1..500 on its own. */
const LIST_LIMIT = 200;
const STATUS_TABS: SuggestionStatus[] = ['pending', 'confirmed', 'reviewed', 'rejected'];
const ADMIN_PATHS = new Set(['/admin', '/admin/suggestions', '/admin/signin', '/admin/in', '/admin/signout', '/admin/suggestions/status', '/admin/suggestions/delete', '/admin/suggestions.csv']);

const themeSources = `'sha256-${alertThemeBootHash}' 'sha256-${alertThemeToggleHash}'`;
const CSP_FORM = `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; script-src https://challenges.cloudflare.com ${turnstileCspSource} ${themeSources}; frame-src https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
const CSP_PLAIN = `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; script-src ${themeSources}; base-uri 'none'; frame-ancestors 'none'`;
/** Page-only rules, mirroring the alerts sheet. The shared sheet already carries the masthead,
 * type, color, button and footer; this adds the filter pills, cards, badges and note fields. */
const adminExtras = `.admin-page{max-width:900px}.admin-page .row{margin:14px 0}.admin-page label{display:grid;gap:6px;font-weight:600}.admin-page input[type=email],.admin-page input[type=search],.admin-page input[type=text],.admin-page textarea{width:100%;padding:12px;border-radius:4px;background:var(--bg);color:var(--ink);border:1px solid var(--line)}.admin-page textarea{font:inherit;min-height:72px;resize:vertical}.admin-page .muted{color:var(--muted);font-size:14px;font-weight:400}.banner{background:var(--soft);border-left:3px solid var(--accent);padding:12px 14px;margin:0 0 16px;color:var(--ink)}.signed-in{overflow-wrap:anywhere;margin:0}.admin-banner{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 0 20px}.admin-banner form{display:inline-flex}.cf-turnstile{margin:12px 0}.admin-page h1{margin-top:0}.admin-page .row button{cursor:pointer;min-height:44px}.filterbar{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.filterbar a{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:8px 14px;border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--muted);font-size:13px;font-weight:600;text-decoration:none}.filterbar a:hover{color:var(--ink);border-color:var(--muted)}.filterbar a[aria-current=page]{border-color:var(--accent);color:var(--accent)}.filterbar .count{background:var(--soft);border-radius:999px;padding:1px 8px;font-size:12px;font-weight:700}.admin-search{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0 20px}.admin-search .q-input{flex:1 1 220px;width:auto}.admin-search button{flex:none;cursor:pointer;min-height:44px}.badges{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}.badge{display:inline-block;padding:3px 10px;border:1px solid var(--line);border-radius:999px;background:var(--soft);color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}.badge.status-confirmed{background:var(--accent);border-color:transparent;color:var(--bg)}.badge.status-reviewed{border-color:var(--accent);color:var(--accent)}.badge.status-rejected{background:var(--alert);border-color:transparent;color:var(--on-alert)}.sug{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:16px 18px;margin:16px 0}.sug h2{margin:0 0 10px;font-size:1.25rem;overflow-wrap:anywhere}.sug .field{margin:6px 0;overflow-wrap:anywhere}.sug .notes{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--soft);border-left:3px solid var(--line);padding:10px 12px;margin:10px 0}.sug .meta{color:var(--muted);font-size:13px;margin:8px 0}.sug label{display:grid;gap:6px;font-weight:600;margin:12px 0 6px}.sug .actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0}.sug form{margin:0}.token-form button{cursor:pointer;min-height:48px;padding:12px 24px;font-weight:700}@media(max-width:390px){.admin-page{max-width:none}.admin-page .row button{width:100%}.admin-banner{gap:8px}.admin-banner form{width:100%}.admin-search .q-input{flex:1 1 100%}}`;

const base = (headers: Record<string, string> = {}, csp = CSP_PLAIN) => ({
	'Content-Type': 'text/html; charset=utf-8',
	'Cache-Control': 'no-store',
	'Referrer-Policy': 'no-referrer',
	'Content-Security-Policy': csp,
	'X-Robots-Tag': 'noindex, nofollow',
	'X-Content-Type-Options': 'nosniff',
	...headers,
});

const searchIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>';
const themeIcon = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor"/></svg>';

/** Same two inline scripts as the alerts shell (and the public masthead boot). The hashes are
 * the CSP allow-list; no other inline script is added, and no analytics beacon runs here.
 * The Español/English switch keeps the current admin path and query, only lang is replaced. */
function render(title: string, body: string, options: { lang: Language; langEs: string; langEn: string; status?: number; headers?: Record<string, string>; csp?: string }): Response {
	const lang = options.lang;
	const t = translate(lang);
	const home = localUrl('/', lang);
	const alertsHref = localUrl('/alerts', lang);
	const suggestHref = localUrl('/sugerir', lang);
	const sectionName = (slug: string, name: string) => lang === 'en' ? englishSections[primarySection(slug)] ?? name : navigationSections.find(([s]) => s === primarySection(slug))?.[1] ?? name;
	const sectionLink = (slug: string, name: string, extra = '') => `<a ${extra}href="${localUrl('/s/' + slug, lang)}">${sectionName(slug, name)}</a>`;
	const contact = 'prnews@code.pr';
	const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex, nofollow"><title>${title} · news.dev.pr</title>${faviconLinks}<link rel="preload" href="${FONT_PATH}" as="font" type="font/woff2" crossorigin><style>${css}${adminExtras}</style><script>${alertThemeBoot}</script></head><body><a class="skip" href="#contenido">${t('Ir al contenido', 'Skip to content')}</a><header class="wrap masthead"><div><a class="brand" href="${home}">news<b>.dev.pr</b></a><div class="tagline">${t('Noticias de Puerto Rico', 'Puerto Rico News')}</div></div><div class="mast-tools"><form class="header-search" action="/search" method="get" role="search"><input type="hidden" name="lang" value="${lang}"><label class="visually-hidden" for="site-search">${t('Buscar noticias', 'Search news')}</label><label class="search-open" for="site-search" aria-hidden="true">${searchIcon}</label><div><input id="site-search" name="q" type="search" maxlength="200" placeholder="${t('Buscar noticias…', 'Search news…')}"><button type="submit" aria-label="${t('Buscar noticias', 'Search news')}">${searchIcon}</button></div></form><a class="alerts-link" href="${alertsHref}">${t('Mis alertas', 'My alerts')}</a><a class="alerts-link" href="${suggestHref}">${t('Sugerir', 'Suggest')}</a><nav class="languages" aria-label="${t('Idioma', 'Language')}"><a href="${escapeHtml(options.langEs)}" lang="es" hreflang="es" aria-current="${lang === 'es'}">Español</a><a href="${escapeHtml(options.langEn)}" lang="en" hreflang="en" aria-current="${lang === 'en'}">English</a></nav><button id="theme" type="button" aria-label="${t('Cambiar tema claro u oscuro', 'Toggle light or dark theme')}" title="${t('Cambiar tema claro u oscuro', 'Toggle light or dark theme')}">${themeIcon}</button></div></header><nav class="nav" aria-label="${t('Secciones', 'Sections')}"><div class="wrap navrow"><div class="tabs"><a href="${home}">${t('Portada', 'Top Stories')}</a>${navigationSections.slice(0, 3).map(([slug, name]) => sectionLink(slug, name)).join('')}</div><details class="more-nav"><summary>${t('Más secciones', 'More sections')}</summary><div>${navigationSections.slice(0, 3).map(([slug, name]) => sectionLink(slug, name, 'class="narrow-only" ')).join('')}${navigationSections.slice(3).map(([slug, name]) => sectionLink(slug, name)).join('')}<a class="alerts-sheet" href="${alertsHref}">${t('Mis alertas', 'My alerts')}</a><a class="alerts-sheet" href="${suggestHref}">${t('Sugerir fuente', 'Suggest a source')}</a></div></details></div></nav><main id="contenido" class="wrap"><div class="admin-page"><h1>${title}</h1>${body}<p><a href="https://news.dev.pr/?lang=${lang}">${t('Volver', 'Back')}</a></p></div></main><footer><div class="wrap digest-footer"><div><h2><a href="${localUrl('/signup', lang)}">${t('Alertas por palabra clave', 'Keyword alerts')}</a></h2><p>${t('Recibe por correo las noticias que coinciden con tu frase; sin contraseñas y máximo un correo por hora. ', 'Get email matches for your phrase; passwordless, at most one email per hour. ')}<a href="${alertsHref}">${t('Mis alertas', 'My alerts')}</a></p></div></div><div class="wrap"><span>${copyrightNotice(lang)}</span><div class="links"><a href="${localUrl('/archive', lang)}">${t('Archivo', 'Archive')}</a><a href="${localUrl('/fuentes', lang)}">${t('Fuentes', 'Sources')}</a><a href="${suggestHref}">${t('Sugerir fuente', 'Suggest a source')}</a><a href="${localUrl('/stats', lang)}">${t('Estadísticas', 'Stats')}</a><a href="${localUrl('/comparar', lang)}">${t('Medios', 'Outlets')}</a><a href="${localUrl('/hall', lang)}">${t('Salón de la fama', 'Hall of fame')}</a><a href="${localUrl('/about', lang)}">${t('Acerca de', 'About')}</a><a href="mailto:${contact}">${contact}</a><a href="/feed">RSS</a></div></div></footer><script>${alertThemeToggle}</script></body></html>`;
	return new Response(html, { status: options.status ?? 200, headers: base(options.headers, options.csp ?? CSP_PLAIN) });
}
const result = (url: URL, lang: Language, message: string, status = 200) => render(translate(lang)('Panel de administración', 'Admin dashboard'), `<p>${message}</p>`, { lang, langEs: langHref(url, 'es'), langEn: langHref(url, 'en'), status });

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** Retry-page retention: normalize whitespace, cap the length, THEN escape — user input is
 * echoed back only inside fully escaped quoted attributes and can break out of nothing. */
const retained = (value: string | null, cap: number) => escapeHtml((value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, cap));
/** Admin search terms: control characters stripped and whitespace collapsed before the value is
 * echoed back (escaped) or re-encoded into a filter href by URLSearchParams. */
const oneLineQuery = (value: string) => value.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/ +/g, ' ').trim().slice(0, QUERY_CAP);

/** Same-origin gate identical to src/alerts-http.ts (kept in sync verbatim): canonical origin is
 * scheme + host + port, with Sec-Fetch-Site browser evidence as the only override for
 * null/rewritten-scheme posts. Raw Origin/Referer values are never logged, only classifications. */
const sameOriginGate = (request: Request): { allow: boolean; why: string } => {
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

/** Form-encoded body reader with the same 8 KiB cap as the alerts gate (admin forms carry only
 * short control fields and a 500-character note, still bounded well below any abuse payload). */
async function readForm(request: Request): Promise<URLSearchParams | undefined> {
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
	return new URLSearchParams(text);
}

function redirect(url: string, cookie?: string): Response {
	const headers = { Location: url, ...base({}, CSP_PLAIN) };
	return new Response(null, { status: 303, headers: cookie ? { ...headers, 'Set-Cookie': cookie } : headers });
}

/** Session cookie scoped to /admin only: the value is the raw session secret (only its hash is
 * stored), HttpOnly, SameSite=Lax, Secure on https, with the session's remaining lifetime. */
function sessionCookie(request: Request, secret: string, maxAge: number): string {
	const https = new URL(request.url).protocol === 'https:' || (request.headers.get('X-Forwarded-Proto') ?? '').includes('https');
	return `${ADMIN_COOKIE}=${secret}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
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

/** Constant-time CSRF comparison, identical to src/alerts-http.ts. */
const timedEqual = (a: string, b: string) => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
};

/* ------------------------------------------------------------------ helpers */

/** Language-switch href for an admin page: same path and query, only lang replaced. */
function langHref(url: URL, lang: Language): string {
	const params = new URLSearchParams(url.searchParams);
	params.set('lang', lang);
	const query = params.toString();
	return url.pathname + (query ? '?' + query : '');
}

/** Canonical /admin/suggestions list URL: only allowlisted filters, always carrying lang. */
function listHref(lang: Language, status: SuggestionStatus | undefined = undefined, kind: SuggestionKind | undefined = undefined, q = ''): string {
	const params = new URLSearchParams();
	params.set('lang', lang);
	if (status) params.set('status', status);
	if (kind) params.set('kind', kind);
	if (q) params.set('q', q);
	return `/admin/suggestions?${params.toString()}`;
}

/** Post-mutation return target: the form's hidden return* filter fields when present, else the
 * same-origin Referer, else the unfiltered dashboard. (Referrer-Policy: no-referrer on every
 * response means the Referer fallback rarely fires; the hidden fields carry the filtered view.) */
function listReturnTo(request: Request, form: URLSearchParams, lang: Language): string {
	const status = STATUS_TABS.find(s => s === form.get('returnStatus'));
	const kindParam = form.get('returnKind');
	const kind: SuggestionKind | undefined = kindParam === 'site' || kindParam === 'influencer' ? kindParam : undefined;
	const q = oneLineQuery(form.get('returnQ') ?? '');
	if (status || kind || q) return listHref(lang, status, kind, q);
	const referer = request.headers.get('Referer');
	if (referer) {
		try {
			const ref = new URL(referer);
			const target = new URL(request.url);
			if (ref.origin.toLowerCase() === target.origin.toLowerCase() && ref.pathname === '/admin/suggestions') return ref.pathname + ref.search;
		} catch { /* not a URL: fall back to the plain dashboard */ }
	}
	return listHref(lang);
}

/** PR-local timestamp, mirroring the owner-notice mail: America/Puerto_Rico is AST year-round. */
function stamp(lang: Language, ts: number | null): string {
	if (ts === null || !Number.isFinite(ts)) return '—';
	return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'es-PR', { timeZone: 'America/Puerto_Rico', dateStyle: 'medium', timeStyle: 'short' }).format(ts) + ' AST';
}

/** http(s) targets become external links (parsed first, protocol re-checked); handles and any
 * unparsable value stay plain escaped text. */
function targetHtml(target: string): string {
	if (/^https?:\/\//i.test(target)) {
		try {
			const u = new URL(target);
			if (u.protocol === 'http:' || u.protocol === 'https:')
				return `<a href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer">${escapeHtml(target)} ↗</a>`;
		} catch { /* fall through to plain text */ }
	}
	return escapeHtml(target);
}

/* ------------------------------------------------------------------ pages */

/** Accessible bilingual sign-in form: label-wrapped email input, shared hidden honeypot and
 * the admin_signin Turnstile widget. Called only when the widget can render, so the site key
 * is present. The email arrives already capped and escaped from retained(). */
function signinForm(env: SuggestionEnv, lang: Language, email: string): string {
	const t = translate(lang);
	const honeypot = `<input type="text" name="x_presencia" value="" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;height:0;width:0">`;
	return `<form method="post" action="/admin/signin?lang=${lang}"><input type="hidden" name="lang" value="${lang}">${honeypot}<div class="row"><label>${t('Correo electrónico', 'Email')} <input type="email" name="email" required maxlength="${EMAIL_CAP}" autocomplete="email" value="${email}"></label></div>${turnstileWidget(env.TURNSTILE_SITE_KEY!, 'admin_signin')}<div class="row"><button type="submit">${t('Enviarme un enlace de acceso', 'Email me a sign-in link')}</button></div></form>`;
}

/** The form renders only with the full verification triangle AND a configured mail backend;
 * otherwise the pause is truthful, exactly like the public suggest form. The page says plainly
 * that access is restricted to the site owner. */
function signinPage(env: SuggestionEnv, lang: Language, url: URL): Response {
	const t = translate(lang);
	const title = t('Panel de administración', 'Admin dashboard');
	const opts = { lang, langEs: langHref(url, 'es'), langEn: langHref(url, 'en') };
	const restricted = `<p class="banner">${t('Acceso restringido al propietario del sitio: este panel solo atiende a la cuenta autorizada del operador.', 'Access restricted to the site owner: this dashboard serves the operator’s authorized account only.')}</p>`;
	if (!turnstileRenderConfigured(env) || !publicAdminConfigured(env)) {
		const notice = t('El acceso de administración está pausado temporalmente: la verificación antiabuso de formularios o el servicio de correo no está activo, así que no se aceptan solicitudes de enlace de acceso.', 'Admin access is temporarily paused: form anti-abuse verification or the mail service is not active, so sign-in link requests are not accepted.');
		return render(title, `${restricted}<p>${notice}</p>`, opts);
	}
	const intro = t('Si corresponde, enviaremos a tu correo un enlace de acceso único que vence en 15 minutos.', 'If eligible, we will send your email a single-use sign-in link that expires in 15 minutes.');
	return render(title, `${restricted}${signinForm(env, lang, '')}<p class="muted">${intro}</p>`, { ...opts, csp: CSP_FORM });
}

/** Honest captcha failure: challenge missing, expired, failed or a network interruption — it
 * happens before anything touches the database, so it reveals nothing about any address. The
 * form is re-rendered with a fresh challenge and the retained (capped, escaped) email. */
function captchaRetryPage(env: SuggestionEnv, lang: Language, url: URL, email: string): Response {
	const t = translate(lang);
	const title = t('Panel de administración', 'Admin dashboard');
	const banner = t('No pudimos verificar tu envío: el desafío antiabuso faltaba, venció o falló (también puede ser una interrupción de red). No se registró nada; tus datos están abajo, revísalos y vuelve a enviar.', 'We could not verify your submission: the anti-abuse challenge was missing, expired, or failed (possibly a network interruption). Nothing was recorded; your details are below — review them and submit again.');
	const publicOk = turnstileRenderConfigured(env) && publicAdminConfigured(env);
	if (!publicOk) return render(title, `<p class="banner">${banner}</p><p><a href="/admin${lang === 'en' ? '?lang=en' : ''}">${t('Abrir el formulario.', 'Open the form.')}</a></p>`, { lang, langEs: langHref(url, 'es'), langEn: langHref(url, 'en'), status: 400 });
	const note = t('Este aviso se refiere solo al desafío antiabuso; no dice nada sobre tu correo.', 'This notice is about the anti-abuse challenge only; it says nothing about your email address.');
	return render(title, `<p class="banner">${banner}</p>${signinForm(env, lang, email)}<p class="muted">${note}</p>`, { lang, langEs: langHref(url, 'es'), langEn: langHref(url, 'en'), status: 400, csp: CSP_FORM });
}

/** Honest validation failure: the address was not well-formed, so nothing was recorded and no
 * mail was sent; the form is re-rendered with the retained (capped, escaped) email. */
function invalidRetryPage(env: SuggestionEnv, lang: Language, url: URL, email: string): Response {
	const t = translate(lang);
	const title = t('Panel de administración', 'Admin dashboard');
	const banner = t('Ingresa un correo electrónico válido (máximo 254 caracteres) para solicitar el enlace de acceso.', 'Enter a valid email address (at most 254 characters) to request a sign-in link.');
	const publicOk = turnstileRenderConfigured(env) && publicAdminConfigured(env);
	if (!publicOk) return render(title, `<p class="banner">${banner}</p><p><a href="/admin${lang === 'en' ? '?lang=en' : ''}">${t('Abrir el formulario.', 'Open the form.')}</a></p>`, { lang, langEs: langHref(url, 'es'), langEn: langHref(url, 'en'), status: 400 });
	return render(title, `<p class="banner">${banner}</p>${signinForm(env, lang, email)}`, { lang, langEs: langHref(url, 'es'), langEn: langHref(url, 'en'), status: 400, csp: CSP_FORM });
}

/** Generic success for every well-formed sign-in request: identical bytes whether or not the
 * address is the owner mailbox, so nothing about ownership is ever disclosed. */
function acceptedSigninPage(lang: Language, url: URL): Response {
	const t = translate(lang);
	return render(t('Panel de administración', 'Admin dashboard'), `<p>${t('Si la dirección está autorizada, se envió un enlace de acceso a tu correo. Revisa tu bandeja de entrada.', 'If authorized, a sign-in link has been sent to your email. Check your inbox.')}</p><p class="muted">${t('El enlace vence en 15 minutos. Si no llega pronto, revisa la carpeta de correo no deseado.', 'The link expires in 15 minutes. If it does not arrive soon, check your spam folder.')}</p>`, { lang, langEs: langHref(url, 'es'), langEn: langHref(url, 'en'), status: 202 });
}

/** Two-step scanner-safe redemption: the emailed GET link renders only this no-store
 * confirmation page; the token itself is redeemed by the POST form, never by the GET. */
function tokenConfirmPage(lang: Language, url: URL, token: string): Response {
	const t = translate(lang);
	const intro = `<p>${t('Solicitaste acceso al panel de administración. Confírmalo con el botón para abrir tu sesión.', 'You requested access to the admin dashboard. Confirm with the button to open your session.')}</p>`;
	const form = `<form class="token-form" method="post" action="/admin/in?lang=${lang}"><input type="hidden" name="lang" value="${lang}"><input type="hidden" name="token" value="${escapeHtml(token)}"><div class="row"><button type="submit">${t('Entrar al panel de administración', 'Sign in to Admin Dashboard')}</button></div></form>`;
	const note = `<p class="muted">${t('El enlace es de un solo uso y vence en 15 minutos. Si no lo solicitaste, cierra esta página.', 'The link is single-use and expires in 15 minutes. If you did not request it, close this page.')}</p>`;
	return render(t('Panel de administración', 'Admin dashboard'), `${intro}${form}${note}`, { lang, langEs: langHref(url, 'es'), langEn: langHref(url, 'en'), csp: CSP_FORM });
}

/** Invalid, expired or already-used link. It never confirms or denies anything else. */
function invalidLinkPage(lang: Language, url: URL): Response {
	const t = translate(lang);
	const clean = new URL(url.pathname, url.origin);
	return render(t('Panel de administración', 'Admin dashboard'), `<p>${t('Este enlace no es válido, venció o ya se usó.', 'This link is invalid, expired, or already used.')}</p><p><a href="/admin${lang === 'en' ? '?lang=en' : ''}">${t('Volver al acceso de administrador', 'Back to admin sign-in')}</a></p>`, { lang, langEs: langHref(clean, 'es'), langEn: langHref(clean, 'en'), status: 400 });
}

/** Honest failure for a blocked mutation: the submission arrived from another origin. It says
 * nothing about any address and nothing was recorded; the visitor gets the canonical sign-in
 * location instead of a fake success that causes endless retries. */
function blockedOriginPage(lang: Language, url: URL): Response {
	const t = translate(lang);
	const body = `<p class="banner">${t('El envío se detuvo en la verificación de origen: llegó desde una página o dominio distinto de este sitio, así que se descartó y no se registró nada.', 'Your submission stopped at the origin check: it arrived from a page or domain other than this site, so it was discarded and nothing was recorded.')}</p><p><a href="/admin${lang === 'en' ? '?lang=en' : ''}">${t('Abre el formulario aquí y envíalo desde esta misma página.', 'Open the form here and submit it from this same page.')}</a></p><p class="muted">${t('Si estás en un visor integrado (previsualizaciones o apps), copia este enlace y ábrelo en tu navegador.', 'If you are in an embedded viewer (previews or apps), copy this link and open it in your browser.')}</p>`;
	return render(t('Panel de administración', 'Admin dashboard'), body, { lang, langEs: langHref(url, 'es'), langEn: langHref(url, 'en'), status: 403 });
}

/** One review card per suggestion: status/kind/language badges, name, link target, the
 * submitter's email as a mailto link (who sent it — the point of the dashboard), notes with
 * preserved line breaks, PR-local timestamps, and the status/note/delete mutations. Every
 * field is strictly escaped; hidden return* fields restore the active filtered view after a
 * mutation (Referrer-Policy: no-referrer makes the Referer fallback unusable). */
function suggestionCard(s: AdminSuggestionRow, session: AdminSession, lang: Language, status: SuggestionStatus | undefined, kind: SuggestionKind | undefined, q: string): string {
	const t = translate(lang);
	const statusLabel = s.status === 'confirmed' ? t('Confirmada', 'Confirmed') : s.status === 'pending' ? t('Pendiente', 'Pending') : s.status === 'reviewed' ? t('Revisada', 'Reviewed') : t('Rechazada', 'Rejected');
	const kindLabel = s.kind === 'influencer' ? t('Influencer de noticias', 'News influencer') : t('Sitio de noticias', 'News site');
	const id = escapeHtml(s.id);
	const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><input type="hidden" name="id" value="${id}"><input type="hidden" name="lang" value="${lang}">${status ? `<input type="hidden" name="returnStatus" value="${status}">` : ''}${kind ? `<input type="hidden" name="returnKind" value="${kind}">` : ''}${q ? `<input type="hidden" name="returnQ" value="${escapeHtml(q)}">` : ''}`;
	const reviewForm = `<form method="post" action="/admin/suggestions/status?lang=${lang}">${hidden}<label for="note-${id}">${t('Nota de administración', 'Admin note')}</label><textarea id="note-${id}" name="admin_note" maxlength="${NOTE_CAP}">${escapeHtml(s.admin_note)}</textarea><div class="actions"><button type="submit" name="status" value="reviewed">${t('Marcar revisada', 'Mark reviewed')}</button><button type="submit" name="status" value="rejected">${t('Rechazar', 'Reject')}</button><button type="submit" name="status" value="confirmed">${t('Reabrir (confirmada)', 'Reopen (confirmed)')}</button><button type="submit" name="status" value="${escapeHtml(s.status)}">${t('Guardar nota', 'Save note')}</button></div></form>`;
	const deleteForm = `<form method="post" action="/admin/suggestions/delete?lang=${lang}">${hidden}<div class="actions"><button type="submit">${t('Eliminar sugerencia', 'Delete suggestion')}</button></div></form>`;
	return `<section class="sug"><div class="badges"><span class="badge status-${escapeHtml(s.status)}">${statusLabel}</span><span class="badge">${kindLabel}</span><span class="badge">${s.language === 'en' ? 'EN' : 'ES'}</span></div><h2>${escapeHtml(s.name)}</h2><p class="field"><span class="muted">${t('Enlace o cuenta', 'Link or account')}: </span>${targetHtml(s.target)}</p><p class="field"><span class="muted">${t('Enviada por', 'Submitted by')}: </span><a href="mailto:${escapeHtml(s.email)}">${escapeHtml(s.email)}</a></p>${s.notes ? `<p class="notes">${escapeHtml(s.notes)}</p>` : ''}<p class="meta">${t('Creada', 'Created')}: ${stamp(lang, s.created_at)} · ${t('Confirmada', 'Confirmed')}: ${stamp(lang, s.confirmed_at)}</p>${reviewForm}${deleteForm}</section>`;
}

/** The Admin Suggestions Dashboard: signed-in banner (owner email, sign-out, CSV export),
 * count pills with one-click status tabs, kind tabs, a search box, and one card per row.
 * Unfiltered by default (status omitted), so the first visit shows everything. */
async function dashboardPage(env: SuggestionEnv, session: AdminSession, lang: Language, url: URL): Promise<Response> {
	const t = translate(lang);
	const statusParam = url.searchParams.get('status') ?? '';
	const status = STATUS_TABS.find(s => s === statusParam);
	const kindParam = url.searchParams.get('kind') ?? '';
	const kind: SuggestionKind | undefined = kindParam === 'site' || kindParam === 'influencer' ? kindParam : undefined;
	const q = oneLineQuery(url.searchParams.get('q') ?? '');
	const { rows, counts } = await listSuggestions(env, { status, kind, q: q || undefined, limit: LIST_LIMIT });
	const banner = `<div class="admin-banner"><p class="signed-in">${t('Sesión iniciada como', 'Signed in as')} <strong>${escapeHtml(session.email)}</strong></p><a href="/admin/suggestions.csv?lang=${lang}">${t('Exportar CSV', 'Export CSV')}</a><form method="post" action="/admin/signout?lang=${lang}"><input type="hidden" name="lang" value="${lang}"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><button type="submit">${t('Cerrar sesión', 'Sign out')}</button></form></div>`;
	const statusTabs: [string, SuggestionStatus | undefined, number][] = [
		[t('Todas', 'All'), undefined, counts.all],
		[t('Confirmadas', 'Confirmed'), 'confirmed', counts.confirmed],
		[t('Pendientes', 'Pending'), 'pending', counts.pending],
		[t('Revisadas', 'Reviewed'), 'reviewed', counts.reviewed],
		[t('Rechazadas', 'Rejected'), 'rejected', counts.rejected],
	];
	const statusTabsHtml = statusTabs.map(([label, tabStatus, count]) =>
		`<a href="${escapeHtml(listHref(lang, tabStatus, kind, q))}"${status === tabStatus ? ' aria-current="page"' : ''}>${label} <span class="count">${count}</span></a>`).join('');
	const kindTabs: [string, SuggestionKind | undefined][] = [
		[t('Todos los tipos', 'All kinds'), undefined],
		[t('Sitios', 'Sites'), 'site'],
		[t('Influencers', 'Influencers'), 'influencer'],
	];
	const kindTabsHtml = kindTabs.map(([label, tabKind]) =>
		`<a href="${escapeHtml(listHref(lang, status, tabKind, q))}"${kind === tabKind ? ' aria-current="page"' : ''}>${label}</a>`).join('');
	const searchForm = `<form class="admin-search" method="get" action="/admin/suggestions" role="search"><input type="hidden" name="lang" value="${lang}">${status ? `<input type="hidden" name="status" value="${status}">` : ''}${kind ? `<input type="hidden" name="kind" value="${kind}">` : ''}<label class="visually-hidden" for="admin-q">${t('Buscar sugerencias', 'Search suggestions')}</label><input class="q-input" id="admin-q" name="q" type="search" maxlength="${QUERY_CAP}" value="${escapeHtml(q)}" placeholder="${t('Nombre, enlace, nota o correo', 'Name, link, note, or email')}"><button type="submit">${t('Buscar', 'Search')}</button></form>`;
	const cards = rows.map(s => suggestionCard(s, session, lang, status, kind, q)).join('');
	const body = `${banner}<nav class="filterbar" aria-label="${t('Estado', 'Status')}">${statusTabsHtml}</nav><nav class="filterbar" aria-label="${t('Tipo', 'Kind')}">${kindTabsHtml}</nav>${searchForm}${cards || `<p>${t('No hay sugerencias que coincidan con este filtro.', 'No suggestions match this filter.')}</p>`}`;
	return render(t('Sugerencias de fuentes', 'Source suggestions'), body, { lang, langEs: langHref(url, 'es'), langEn: langHref(url, 'en'), csp: CSP_FORM });
}

/* ------------------------------------------------------------------ router */

export async function adminSuggestionsRoute(request: Request, env: SuggestionEnv): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (!ADMIN_PATHS.has(url.pathname)) return undefined;
	if (request.method === 'HEAD') return new Response(null, { headers: base() });
	let lang: Language = url.searchParams.get('lang') === 'en' ? 'en' : 'es';
	const t = (es: string, en: string) => translate(lang)(es, en);
	try {
		/* ---- dashboard (also the sign-in landing when no session cookie is valid) ---- */
		if (url.pathname === '/admin' || url.pathname === '/admin/suggestions') {
			if (request.method !== 'GET') return result(url, lang, t('Método no permitido.', 'Method not allowed.'), 405);
			const session = await adminSessionFromCookie(env, cookieValue(request, ADMIN_COOKIE));
			if (!session) return signinPage(env, lang, url);
			return await dashboardPage(env, session, lang, url);
		}
		/* ---- public owner sign-in request ---- */
		if (url.pathname === '/admin/signin') {
			if (request.method !== 'POST') return redirect(`/admin${lang === 'en' ? '?lang=en' : ''}`);
			const origin = sameOriginGate(request);
			if (!origin.allow) { console.error('admin_gate same-origin /admin/signin ' + origin.why); return blockedOriginPage(lang, url); }
			const form = await readForm(request);
			if (!form) { console.error('admin_gate unreadable-form', url.pathname); return result(url, lang, t('Solicitud no válida.', 'Invalid request.'), 400); }
			if (!url.searchParams.has('lang')) lang = form.get('lang') === 'en' ? 'en' : 'es';
			const verdict = await requestAdminSignin(env, {
				email: form.get('email'), captcha: form.get('cf-turnstile-response'), honeypot: form.get('x_presencia'),
				ip: request.headers.get('CF-Connecting-IP'), language: lang,
			});
			if (verdict.status === 'captcha') return captchaRetryPage(env, lang, url, retained(form.get('email'), EMAIL_CAP));
			if (verdict.status === 'invalid') return invalidRetryPage(env, lang, url, retained(form.get('email'), EMAIL_CAP));
			if (verdict.status === 'unavailable') return result(url, lang, t('El servicio de administración no está disponible temporalmente. Intenta de nuevo más tarde.', 'The admin service is temporarily unavailable. Please try again later.'), 503);
			return acceptedSigninPage(lang, url);
		}
		/* ---- two-step magic-link redemption ---- */
		if (url.pathname === '/admin/in') {
			if (request.method === 'GET') {
				const token = url.searchParams.get('token') ?? '';
				if (!/^[a-f0-9]{64}$/.test(token)) return invalidLinkPage(lang, url);
				return tokenConfirmPage(lang, url, token);
			}
			if (request.method !== 'POST') return result(url, lang, t('Método no permitido.', 'Method not allowed.'), 405);
			const origin = sameOriginGate(request);
			if (!origin.allow) { console.error('admin_gate same-origin /admin/in ' + origin.why); return blockedOriginPage(lang, url); }
			const form = await readForm(request);
			if (!form) { console.error('admin_gate unreadable-form', url.pathname); return result(url, lang, t('Solicitud no válida.', 'Invalid request.'), 400); }
			if (!url.searchParams.has('lang')) lang = form.get('lang') === 'en' ? 'en' : 'es';
			const verdict = await redeemAdminToken(env, form.get('token') ?? '');
			if (!verdict.ok) {
				if (verdict.status === 'unavailable') return result(url, lang, t('El servicio de administración no está disponible temporalmente. Intenta de nuevo más tarde.', 'The admin service is temporarily unavailable. Please try again later.'), 503);
				return invalidLinkPage(lang, url);
			}
			const maxAge = Math.max(1, Math.floor((verdict.session.expiresAt - Date.now()) / 1000));
			return redirect(listHref(lang), sessionCookie(request, verdict.session.secret, maxAge));
		}
		/* ---- sign out ---- */
		if (url.pathname === '/admin/signout') {
			if (request.method !== 'POST') return result(url, lang, t('Método no permitido.', 'Method not allowed.'), 405);
			const origin = sameOriginGate(request);
			if (!origin.allow) { console.error('admin_gate same-origin /admin/signout ' + origin.why); return blockedOriginPage(lang, url); }
			const secret = cookieValue(request, ADMIN_COOKIE);
			const session = await adminSessionFromCookie(env, secret);
			if (!session) return result(url, lang, t('Sesión vencida. Inicia sesión de nuevo.', 'Session expired. Sign in again.'), 401);
			const form = await readForm(request);
			if (!form) { console.error('admin_gate unreadable-form', url.pathname); return result(url, lang, t('Solicitud no válida.', 'Invalid request.'), 400); }
			if (!url.searchParams.has('lang')) lang = form.get('lang') === 'en' ? 'en' : 'es';
			if (!timedEqual(form.get('csrf') ?? '', session.csrf)) return result(url, lang, t('Solicitud no válida.', 'Invalid request.'), 403);
			await signOutAdmin(env, secret);
			return redirect(`/admin${lang === 'en' ? '?lang=en' : ''}`, dropCookie(request));
		}
		/* ---- session-scoped mutations ---- */
		if (url.pathname === '/admin/suggestions/status' || url.pathname === '/admin/suggestions/delete') {
			if (request.method !== 'POST') return result(url, lang, t('Método no permitido.', 'Method not allowed.'), 405);
			const origin = sameOriginGate(request);
			if (!origin.allow) { console.error('admin_gate same-origin ' + url.pathname + ' ' + origin.why); return blockedOriginPage(lang, url); }
			const session = await adminSessionFromCookie(env, cookieValue(request, ADMIN_COOKIE));
			if (!session) return result(url, lang, t('Sesión vencida. Inicia sesión de nuevo.', 'Session expired. Sign in again.'), 401);
			const form = await readForm(request);
			if (!form) { console.error('admin_gate unreadable-form', url.pathname); return result(url, lang, t('Solicitud no válida.', 'Invalid request.'), 400); }
			if (!url.searchParams.has('lang')) lang = form.get('lang') === 'en' ? 'en' : 'es';
			if (!timedEqual(form.get('csrf') ?? '', session.csrf)) return result(url, lang, t('Solicitud no válida.', 'Invalid request.'), 403);
			if (url.pathname === '/admin/suggestions/status') {
				const status = form.get('status') ?? '';
				const id = (form.get('id') ?? '').slice(0, ID_CAP);
				if (!(STATUS_TABS as string[]).includes(status) || !id) return result(url, lang, t('Solicitud no válida.', 'Invalid request.'), 403);
				await updateSuggestionStatus(env, {
					id, status: status as SuggestionStatus,
					adminNote: form.has('admin_note') ? (form.get('admin_note') ?? '').slice(0, NOTE_CAP) : undefined,
				});
			} else {
				const id = (form.get('id') ?? '').slice(0, ID_CAP);
				if (!id) return result(url, lang, t('Solicitud no válida.', 'Invalid request.'), 403);
				await deleteSuggestion(env, id);
			}
			return redirect(listReturnTo(request, form, lang));
		}
		/* ---- CSV export (session-gated; nosniff + no-store, never cached) ---- */
		if (url.pathname === '/admin/suggestions.csv') {
			if (request.method !== 'GET') return result(url, lang, t('Método no permitido.', 'Method not allowed.'), 405);
			const session = await adminSessionFromCookie(env, cookieValue(request, ADMIN_COOKIE));
			if (!session) return redirect(`/admin${lang === 'en' ? '?lang=en' : ''}`);
			const csv = await exportSuggestionsCsv(env);
			return new Response(csv, { status: 200, headers: base({
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': 'attachment; filename="suggestions.csv"',
			}) });
		}
		return undefined;
	} catch {
		return result(url, lang, t('Actualizando… Intenta de nuevo pronto.', 'Updating… Please try again shortly.'), 503);
	}
}
