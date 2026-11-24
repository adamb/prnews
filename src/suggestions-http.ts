/**
 * HTTP routes for news-site and news-influencer suggestions: /sugerir and its /suggest alias,
 * plus /sugerir/confirm (+ /suggest/confirm). All pages: no-store, no-indexing, no referrers,
 * no analytics beacon, and no tokens in URLs after single-use redemption.
 * Security posture (mirrors src/alerts-http.ts):
 *  - The public submission endpoint runs the same same-origin gate, a honeypot, a 16 KiB body
 *    cap and Cloudflare Turnstile server-side verification. When the Turnstile secret/site
 *    key is missing or the suggestions backend is not configured, the form is truthfully
 *    paused — there is never an unprotected public email endpoint.
 *  - Confirmation links are single-use, expiring tokens; redemption immediately
 *    303-redirects to a clean ?done=1 URL so the token never stays in browser history.
 *  - The accepted response is generic and reveals nothing about whether an address was seen
 *    before; a blocked-origin submission and a failed anti-abuse challenge each keep their
 *    own honest localized retry guidance (nothing recorded, no implied state).
 *  - Every user-supplied value is length-capped and HTML-escaped before it is echoed back
 *    into a retry form, only inside fully escaped quoted attributes.
 *  - Field caps mirror the backend limits: name 120, target 300, notes 400, email 254.
 */
import {
	submitSuggestion, confirmSuggestion, publicSuggestionsConfigured, type SuggestionEnv,
} from './suggestions';
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
/** Backend field limits (src/suggestions.ts sanitizeSuggestionInput), mirrored in the
 * maxlength attributes of the form below: name 2–120, target 2–300, notes ≤400, email ≤254. */
const NAME_CAP = 120, TARGET_CAP = 300, NOTES_CAP = 400, EMAIL_CAP = 254;

const themeSources = `'sha256-${alertThemeBootHash}' 'sha256-${alertThemeToggleHash}'`;
const CSP_FORM = `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; script-src https://challenges.cloudflare.com ${turnstileCspSource} ${themeSources}; frame-src https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
const CSP_PLAIN = `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; script-src ${themeSources}; base-uri 'none'; frame-ancestors 'none'`;
/** Page-only rules, mirroring the alerts sheet. The shared sheet already carries the masthead,
 * type, color, button and footer; this adds the fieldset/legend radios and the notes textarea. */
const suggestExtras = `.suggest-page{max-width:720px}.suggest-page .row{margin:14px 0}.suggest-page label{display:grid;gap:6px;font-weight:600}.suggest-page input[type=email],.suggest-page input[type=text],.suggest-page textarea{width:100%;padding:12px;border-radius:4px;background:var(--bg);color:var(--ink);border:1px solid var(--line)}.suggest-page textarea{font:inherit;min-height:96px;resize:vertical}.suggest-page .muted{color:var(--muted);font-size:14px}.banner{background:var(--soft);border-left:3px solid var(--accent);padding:12px 14px;margin:0 0 16px;color:var(--ink)}.suggest-page fieldset{margin:14px 0;padding:12px 16px;border:1px solid var(--line);border-radius:6px;display:grid;gap:10px}.suggest-page legend{font-weight:600;padding:0 6px}.suggest-page fieldset label{font-weight:400;display:flex;align-items:center;gap:10px}.suggest-page fieldset input[type=radio]{width:18px;height:18px;flex:none;margin:0;accent-color:var(--accent)}.cf-turnstile{margin:12px 0}.suggest-page h1{margin-top:0}.suggest-page .row button{cursor:pointer;min-height:44px}@media(max-width:390px){.suggest-page{max-width:none}.suggest-page .row button{width:100%}}`;

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

/** Same two inline scripts as the alerts shell (and the public masthead boot). The hashes are
 * the CSP allow-list; no other inline script is added, and no analytics beacon runs here. */
function render(title: string, body: string, options: { lang: Language; status?: number; headers?: Record<string, string>; csp?: string }): Response {
	const lang = options.lang;
	const t = translate(lang);
	const home = localUrl('/', lang);
	const alertsHref = localUrl('/alerts', lang);
	const suggestHref = localUrl('/sugerir', lang);
	const sectionName = (slug: string, name: string) => lang === 'en' ? englishSections[primarySection(slug)] ?? name : navigationSections.find(([s]) => s === primarySection(slug))?.[1] ?? name;
	const sectionLink = (slug: string, name: string, extra = '') => `<a ${extra}href="${localUrl('/s/' + slug, lang)}">${sectionName(slug, name)}</a>`;
	const contact = 'prnews@code.pr';
	const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex, nofollow"><title>${title} · news.dev.pr</title>${faviconLinks}<link rel="preload" href="${FONT_PATH}" as="font" type="font/woff2" crossorigin><style>${css}${suggestExtras}</style><script>${alertThemeBoot}</script></head><body><a class="skip" href="#contenido">${t('Ir al contenido', 'Skip to content')}</a><header class="wrap masthead"><div><a class="brand" href="${home}">news<b>.dev.pr</b></a><div class="tagline">${t('Noticias de Puerto Rico', 'Puerto Rico News')}</div></div><div class="mast-tools"><form class="header-search" action="/search" method="get" role="search"><input type="hidden" name="lang" value="${lang}"><label class="visually-hidden" for="site-search">${t('Buscar noticias', 'Search news')}</label><label class="search-open" for="site-search" aria-hidden="true">${searchIcon}</label><div><input id="site-search" name="q" type="search" maxlength="200" placeholder="${t('Buscar noticias…', 'Search news…')}"><button type="submit" aria-label="${t('Buscar noticias', 'Search news')}">${searchIcon}</button></div></form><a class="alerts-link" href="${alertsHref}">${t('Mis alertas', 'My alerts')}</a><a class="alerts-link" href="${suggestHref}" aria-current="page">${t('Sugerir', 'Suggest')}</a><nav class="languages" aria-label="${t('Idioma', 'Language')}"><a href="${localUrl('/sugerir', 'es')}" lang="es" hreflang="es" aria-current="${lang === 'es'}">Español</a><a href="${localUrl('/sugerir', 'en')}" lang="en" hreflang="en" aria-current="${lang === 'en'}">English</a></nav><button id="theme" type="button" aria-label="${t('Cambiar tema claro u oscuro', 'Toggle light or dark theme')}" title="${t('Cambiar tema claro u oscuro', 'Toggle light or dark theme')}">${themeIcon}</button></div></header><nav class="nav" aria-label="${t('Secciones', 'Sections')}"><div class="wrap navrow"><div class="tabs"><a href="${home}">${t('Portada', 'Top Stories')}</a>${navigationSections.slice(0, 3).map(([slug, name]) => sectionLink(slug, name)).join('')}</div><details class="more-nav"><summary>${t('Más secciones', 'More sections')}</summary><div>${navigationSections.slice(0, 3).map(([slug, name]) => sectionLink(slug, name, 'class="narrow-only" ')).join('')}${navigationSections.slice(3).map(([slug, name]) => sectionLink(slug, name)).join('')}<a class="alerts-sheet" href="${alertsHref}">${t('Mis alertas', 'My alerts')}</a><a class="alerts-sheet" href="${suggestHref}" aria-current="page">${t('Sugerir fuente', 'Suggest a source')}</a></div></details></div></nav><main id="contenido" class="wrap"><div class="suggest-page"><h1>${title}</h1>${body}<p><a href="https://news.dev.pr/?lang=${lang}">${t('Volver', 'Back')}</a></p></div></main><footer><div class="wrap digest-footer"><div><h2><a href="${localUrl('/signup', lang)}">${t('Alertas por palabra clave', 'Keyword alerts')}</a></h2><p>${t('Recibe por correo las noticias que coinciden con tu frase; sin contraseñas y máximo un correo por hora. ', 'Get email matches for your phrase; passwordless, at most one email per hour. ')}<a href="${alertsHref}">${t('Mis alertas', 'My alerts')}</a></p></div></div><div class="wrap"><span>${copyrightNotice(lang)}</span><div class="links"><a href="${localUrl('/archive', lang)}">${t('Archivo', 'Archive')}</a><a href="${localUrl('/fuentes', lang)}">${t('Fuentes', 'Sources')}</a><a href="${suggestHref}">${t('Sugerir fuente', 'Suggest a source')}</a><a href="${localUrl('/stats', lang)}">${t('Estadísticas', 'Stats')}</a><a href="${localUrl('/comparar', lang)}">${t('Medios', 'Outlets')}</a><a href="${localUrl('/hall', lang)}">${t('Salón de la fama', 'Hall of fame')}</a><a href="${localUrl('/about', lang)}">${t('Acerca de', 'About')}</a><a href="mailto:${contact}">${contact}</a><a href="/feed">RSS</a></div></div></footer><script>${alertThemeToggle}</script></body></html>`;
	return new Response(html, { status: options.status ?? 200, headers: base(options.headers, options.csp ?? CSP_PLAIN) });
}
const result = (lang: Language, message: string, status = 200) => render(translate(lang)('Sugerir fuente', 'Suggest a source'), `<p>${message}</p>`, { lang, status });

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** Retry-page retention: normalize whitespace, cap the length, THEN escape — user input is
 * echoed back only inside fully escaped quoted attributes and can break out of nothing. */
const retained = (value: string | null, cap: number) => escapeHtml((value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, cap));
/** Notes retention keeps newlines (safe once escaped) so multi-line notes survive a retry. */
const retainedNotes = (value: string | null) => escapeHtml((value ?? '').replace(/\r\n?/g, '\n').slice(0, NOTES_CAP));

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

/** Form-encoded body reader with a 16 KiB cap (suggestions carry optional notes, so the cap is
 * larger than the alerts gate's 8 KiB but still bounded well below any abuse payload). */
async function readForm(request: Request): Promise<URLSearchParams | undefined> {
	const reader = request.body?.getReader();
	const decoder = new TextDecoder();
	let size = 0, text = '';
	if (reader) while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > 16384) { await reader.cancel(); return undefined; }
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	const type = request.headers.get('Content-Type') ?? '';
	if (type && !type.includes('form')) return undefined;
	return new URLSearchParams(text);
}

function redirect(url: string): Response {
	return new Response(null, { status: 303, headers: { Location: url, ...base() } });
}

/* ------------------------------------------------------------------ pages */

/** Retained form state for honest retry pages: every value is already capped and escaped. */
interface SuggestForm { kind: 'site' | 'influencer'; name: string; target: string; notes: string; email: string }
const emptyForm: SuggestForm = { kind: 'site', name: '', target: '', notes: '', email: '' };
const retainedForm = (form: URLSearchParams): SuggestForm => ({
	kind: form.get('kind') === 'influencer' ? 'influencer' : 'site',
	name: retained(form.get('name'), NAME_CAP),
	target: retained(form.get('target'), TARGET_CAP),
	notes: retainedNotes(form.get('notes')),
	email: retained(form.get('email'), EMAIL_CAP),
});

/** Accessible bilingual form: label-wrapped inputs, fieldset/legend radios, maxlength mirroring
 * the backend caps, autocomplete="email", and the shared hidden honeypot. Called only when the
 * widget can render, so the site key is present. */
function suggestForm(env: SuggestionEnv, lang: Language, values: SuggestForm = emptyForm): string {
	const t = translate(lang);
	const honeypot = `<input type="text" name="x_presencia" value="" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;height:0;width:0">`;
	return `<form method="post" action="${localUrl('/sugerir', lang)}"><input type="hidden" name="lang" value="${lang}">${honeypot}<fieldset><legend>${t('¿Qué quieres sugerir?', 'What would you like to suggest?')}</legend><label><input type="radio" name="kind" value="site"${values.kind === 'site' ? ' checked' : ''}> ${t('Sitio de noticias', 'News site')}</label><label><input type="radio" name="kind" value="influencer"${values.kind === 'influencer' ? ' checked' : ''}> ${t('Influencer de noticias', 'News influencer')}</label></fieldset><div class="row"><label>${t('Nombre', 'Name')} <input type="text" name="name" required maxlength="${NAME_CAP}" value="${values.name}" placeholder="${t('Nombre del sitio o del influencer', 'Name of the site or the influencer')}"></label></div><div class="row"><label>${t('Enlace o cuenta', 'Link or account')} <input type="text" name="target" required maxlength="${TARGET_CAP}" inputmode="url" value="${values.target}" placeholder="${t('p. ej. https://unmedio.com o @cuenta', 'e.g. https://anoutlet.com or @handle')}"></label></div><div class="row"><label>${t('Notas (opcional)', 'Notes (optional)')} <textarea name="notes" maxlength="${NOTES_CAP}">${values.notes}</textarea></label></div><div class="row"><label>${t('Correo electrónico', 'Email')} <input type="email" name="email" required maxlength="${EMAIL_CAP}" autocomplete="email" value="${values.email}"></label></div>${turnstileWidget(env.TURNSTILE_SITE_KEY!, 'suggest')}<div class="row"><button type="submit">${t('Enviar sugerencia', 'Send suggestion')}</button></div></form>`;
}

/** The form renders only with the full verification triangle (Turnstile secret + site key +
 * hostname allowlist) AND a configured suggestions backend; otherwise the pause is truthful. */
function suggestPage(env: SuggestionEnv, lang: Language): Response {
	const t = translate(lang);
	const title = t('Sugerir fuente', 'Suggest a source');
	if (!turnstileRenderConfigured(env) || !publicSuggestionsConfigured(env)) {
		const notice = !turnstileRenderConfigured(env)
			? t('Las sugerencias de fuentes están pausadas temporalmente: la verificación antiabuso de formularios no está activa, así que no se aceptan nuevas sugerencias.', 'Source suggestions are temporarily paused: the form anti-abuse verification is not active, so new suggestions are not accepted.')
			: t('Las sugerencias de fuentes están pausadas temporalmente: el servicio de sugerencias no está disponible, así que no se aceptan nuevas sugerencias.', 'Source suggestions are temporarily paused: the suggestions service is unavailable, so new suggestions are not accepted.');
		return render(title, `<p>${notice}</p>`, { lang });
	}
	const intro = `<p class="muted">${t('Sugiere un sitio de noticias de Puerto Rico o un influencer de noticias para considerar como fuente. Te enviamos un correo para confirmar que la sugerencia salió de ti.', 'Suggest a Puerto Rico news site or a news influencer to consider as a source. We email you to confirm the suggestion came from you.')}</p>`;
	return render(title, `${intro}${suggestForm(env, lang)}<p class="muted">${t('Tu correo solo se usa para confirmar esta sugerencia; no se publica.', 'Your email is only used to confirm this suggestion; it is not published.')}</p>`, { lang, csp: CSP_FORM });
}

/** Honest failure for a blocked mutation: the submission arrived from another origin. It says
 * nothing about any address and nothing was recorded; the visitor gets the canonical form
 * location instead of a fake success that causes endless retries. */
function blockedOriginPage(lang: Language): Response {
	const t = translate(lang);
	const body = `<p class="banner">${t('El envío se detuvo en la verificación de origen: llegó desde una página o dominio distinto de este sitio, así que se descartó y no se registró nada.', 'Your submission stopped at the origin check: it arrived from a page or domain other than this site, so it was discarded and nothing was recorded.')}</p><p><a href="${localUrl('/sugerir', lang)}">${t('Abre el formulario aquí y envíalo desde esta misma página.', 'Open the form here and submit it from this same page.')}</a></p><p class="muted">${t('Si estás en un visor integrado (previsualizaciones o apps), copia este enlace y ábrelo en tu navegador.', 'If you are in an embedded viewer (previews or apps), copy this link and open it in your browser.')}</p>`;
	return render(translate(lang)('Sugerir fuente', 'Suggest a source'), body, { lang, status: 403 });
}

/** Honest captcha failure: challenge missing, expired, failed or a network interruption — it
 * happens before any database access, so it reveals nothing about any address. The form is
 * re-rendered with a fresh challenge and the retained (capped, escaped) input. */
function captchaRetryPage(env: SuggestionEnv, lang: Language, values: SuggestForm): Response {
	const t = translate(lang);
	const banner = t('No pudimos verificar tu envío: el desafío antiabuso faltaba, venció o falló (también puede ser una interrupción de red). No se registró nada; tus datos están abajo, revísalos y vuelve a enviar.', 'We could not verify your submission: the anti-abuse challenge was missing, expired, or failed (possibly a network interruption). Nothing was recorded; your details are below — review them and submit again.');
	const publicOk = turnstileRenderConfigured(env) && publicSuggestionsConfigured(env);
	if (!publicOk) return render(t('Sugerir fuente', 'Suggest a source'), `<p class="banner">${banner}</p><p><a href="${localUrl('/sugerir', lang)}">${t('Abrir el formulario.', 'Open the form.')}</a></p>`, { lang, status: 400 });
	const form = suggestForm(env, lang, values);
	const note = t('Este aviso se refiere solo al desafío antiabuso; no dice nada sobre tu correo.', 'This notice is about the anti-abuse challenge only; it says nothing about your email address.');
	return render(t('Sugerir fuente', 'Suggest a source'), `<p class="banner">${banner}</p>${form}<p class="muted">${note}</p>`, { lang, status: 400, csp: CSP_FORM });
}

/** Honest validation failure: a bilingual per-field explanation plus the retained (capped,
 * escaped) input in a fresh form. The backend never records an invalid submission. */
function invalidRetryPage(env: SuggestionEnv, lang: Language, field: string | undefined, values: SuggestForm): Response {
	const t = translate(lang);
	const banner = field === 'email'
		? t('Ingresa un correo válido de máximo 254 caracteres.', 'Enter a valid email address, at most 254 characters.')
		: field === 'name'
			? t('Escribe el nombre del sitio o del influencer (entre 2 y 120 caracteres).', 'Enter the name of the site or the influencer (between 2 and 120 characters).')
			: field === 'target'
				? t('Ingresa el enlace del sitio o la cuenta social (entre 2 y 300 caracteres).', 'Enter the site link or the social account (between 2 and 300 characters).')
				: field === 'kind'
					? t('Elige si sugieres un sitio de noticias o un influencer de noticias.', 'Choose whether you are suggesting a news site or a news influencer.')
					: field === 'notes'
						? t('Las notas no pueden pasar de 400 caracteres.', 'Notes cannot exceed 400 characters.')
						: t('Revisa los campos del formulario: falta algún dato o no es válido.', 'Review the form fields: a value is missing or invalid.');
	const publicOk = turnstileRenderConfigured(env) && publicSuggestionsConfigured(env);
	if (!publicOk) return render(t('Sugerir fuente', 'Suggest a source'), `<p class="banner">${banner}</p><p><a href="${localUrl('/sugerir', lang)}">${t('Abrir el formulario.', 'Open the form.')}</a></p>`, { lang, status: 400 });
	return render(t('Sugerir fuente', 'Suggest a source'), `<p class="banner">${banner}</p>${suggestForm(env, lang, values)}`, { lang, status: 400, csp: CSP_FORM });
}

/** Generic success for every valid submission: identical bytes whether or not the address was
 * seen before, so nothing about any prior suggestion is ever disclosed. */
function acceptedPage(lang: Language): Response {
	const t = translate(lang);
	return render(t('Sugerir fuente', 'Suggest a source'), `<p>${t('Recibimos tu sugerencia. Revisa tu correo para confirmarla.', 'We received your suggestion. Check your email to confirm it.')}</p><p class="muted">${t('Si no llega pronto, revisa la carpeta de correo no deseado.', 'If it does not arrive soon, check your spam folder.')}</p>`, { lang, status: 202 });
}

/** Clean post-redemption landing page: reached at /sugerir/confirm?done=1, with no token in the
 * URL or browser history. */
function confirmedDonePage(lang: Language): Response {
	const t = translate(lang);
	return render(t('Sugerencia confirmada', 'Suggestion confirmed'), `<p>${t('¡Sugerencia confirmada! Gracias.', 'Suggestion confirmed! Thank you.')}</p><p class="muted">${t('Tu sugerencia quedó registrada para revisión. No se necesitan más pasos; puedes cerrar esta página.', 'Your suggestion is recorded for review. No further steps are needed; you can close this page.')}</p>`, { lang });
}

function invalidLinkPage(lang: Language): Response {
	const t = translate(lang);
	return render(t('Sugerir fuente', 'Suggest a source'), `<p>${t('Este enlace no es válido, venció o ya se usó. Este mensaje no confirma ninguna sugerencia.', 'This link is invalid, expired, or already used. This message does not confirm any suggestion.')}</p><p><a href="${localUrl('/sugerir', lang)}">${t('Sugerir otra fuente', 'Suggest another source')}</a></p>`, { lang, status: 400 });
}

const unavailableResult = (lang: Language) => result(lang, translate(lang)('El servicio de sugerencias no está disponible temporalmente. Intenta de nuevo más tarde.', 'The suggestions service is temporarily unavailable. Please try again later.'), 503);
const rateLimitedResult = (lang: Language) => result(lang, translate(lang)('Demasiadas sugerencias desde esta conexión en poco tiempo. Espera un rato antes de intentar de nuevo.', 'Too many suggestions from this connection in a short time. Please wait a while before trying again.'), 429);

/* ------------------------------------------------------------------ router */

export async function suggestionsRoute(request: Request, env: SuggestionEnv): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.pathname !== '/sugerir' && url.pathname !== '/suggest' && url.pathname !== '/sugerir/confirm' && url.pathname !== '/suggest/confirm') return undefined;
	if (request.method === 'HEAD') return new Response(null, { headers: base() });
	let lang: Language = url.searchParams.get('lang') === 'en' ? 'en' : 'es';
	const t = (es: string, en: string) => translate(lang)(es, en);
	try {
		if (url.pathname === '/sugerir' || url.pathname === '/suggest') {
			if (request.method === 'GET') return suggestPage(env, lang);
			if (request.method !== 'POST') return result(lang, t('Método no permitido.', 'Method not allowed.'), 405);
			const origin = sameOriginGate(request);
			if (!origin.allow) { console.error('suggestions_gate same-origin ' + url.pathname + ' ' + origin.why); return blockedOriginPage(lang); }
			const form = await readForm(request);
			if (!form) { console.error('suggestions_gate unreadable-form', url.pathname); return result(lang, t('Solicitud no válida.', 'Invalid request.'), 400); }
			if (!url.searchParams.has('lang')) lang = form.get('lang') === 'en' ? 'en' : 'es';
			const values = retainedForm(form);
			const verdict = await submitSuggestion(env, {
				kind: form.get('kind'), name: form.get('name'), target: form.get('target'), notes: form.get('notes') ?? undefined,
				email: form.get('email'), language: lang, turnstileToken: form.get('cf-turnstile-response'),
				honeypot: form.get('x_presencia'), ip: request.headers.get('CF-Connecting-IP'),
			});
			if (verdict.ok) return acceptedPage(lang);
			if (verdict.status === 'captcha') return captchaRetryPage(env, lang, values);
			if (verdict.status === 'invalid') return invalidRetryPage(env, lang, verdict.field, values);
			if (verdict.status === 'unavailable') return unavailableResult(lang);
			return rateLimitedResult(lang);
		}
		if (request.method !== 'GET') return result(lang, t('Método no permitido.', 'Method not allowed.'), 405);
		if (url.searchParams.get('done') === '1') return confirmedDonePage(lang);
		const verdict = await confirmSuggestion(env, url.searchParams.get('token') ?? '');
		if (verdict.ok) return redirect(`/sugerir/confirm?done=1&lang=${lang}`);
		if (verdict.status === 'unavailable') return unavailableResult(lang);
		return invalidLinkPage(lang);
	} catch {
		return result(lang, t('Actualizando… Intenta de nuevo pronto.', 'Updating… Please try again shortly.'), 503);
	}
}
