/**
 * Keyword alerts end-to-end tests against real migration SQL and fetch mocks.
 * No real email is ever sent: every ImprovMX/Turnstile call is mocked. Coverage:
 * captcha gating, honeypot, generic anti-enumeration responses, double-opt-in activation
 * watermark, per-article per-person dedup (matching + later translations), pause/delete/
 * pause-all/unsubscribe-all, one-hour batching, scoped sessions, CSRF, cross-user isolation,
 * single-use token replay, uncertain-send resolution (never auto-duplicated), 429 handling
 * and terminal rejections. Also fixes the sending identity: ImprovMX Send API to prnews@code.pr.
 */
import {describe,it,expect,vi,afterEach,beforeEach} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {
	runAlertSweep, subscribe, confirm, requestSignin, useMagicLink, manageWatcher, sessionFromCookie,
	unsubscribeToken, phraseMatches, phraseTokens, setPacingForTests, confirmedAlertAccountCounts,
	OWNER_SIGNUP_EMAIL, closeAccount, type AlertEnv,
} from '../src/alerts';
import renderer from '../src/render';
import { alertsRoute, alertThemeBoot, alertThemeToggle, alertThemeBootHash, alertThemeToggleHash } from '../src/alerts-http';
import { turnstileClientScript, turnstileClientScriptHash } from '../src/turnstile';
import type { Item } from '../src/parse';

const MIGRATIONS = ['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql', '0009_alerts.sql', '0013_owner_signup_notice.sql', '0018_history.sql'];
function database() {
	const db = new DatabaseSync(':memory:');
	for (const name of MIGRATIONS) db.exec(readFileSync(`migrations/${name}`, 'utf8'));
	const DB = { prepare: (sql: string) => {
		const chain = (...args: unknown[]) => ({
			first: async () => db.prepare(sql).get(...(args as any[])) ?? null,
			all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }),
			run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as any[])).changes ?? 0) } }),
		});
		return { bind: chain, first: chain().first, all: chain().all, run: chain().run };
	} } as unknown as D1Database;
	return { DB, db };
}
const baseEnv = (DB: D1Database): AlertEnv => ({
	DB, IMPROVMX_API_KEY: 'improv-fake-key', ALERTS_FROM: 'prnews', ALERTS_DOMAIN: 'code.pr',
	DIGEST_TOKEN_SECRET: 's'.repeat(40), TURNSTILE_SECRET_KEY: 'turnstile-secret', TURNSTILE_SITE_KEY: '0xSITEKEY', TURNSTILE_HOSTNAMES: 'news.dev.pr',
} as unknown as AlertEnv);
const item = (url: string, title: string, time: number, summary = 'Extracto base.'): Item & { time: number } =>
	({ url, source: 'noticel', title, summary, image: '', observed: false, time, section: 'otras', reason: '' });
const insertArticle = (env: AlertEnv, article: Item, firstSeen: number, translation?: unknown) =>
	env.DB.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at,translation) VALUES(?,?,?,?,?,?,?)')
		.bind((article as Item).url, (article as Item).source, JSON.stringify(article), firstSeen, firstSeen, (article as Item).time, translation ? JSON.stringify(translation) : null).run();
const getOutbox = (env: AlertEnv, kind: string) => env.DB.prepare('SELECT id,kind,account_id,email,payload,state,attempts,attempt_at,lease_until,created_at FROM alert_outbox WHERE kind=? ORDER BY created_at DESC').bind(kind);
const isOwnerSend = (call: FetchCall) => String((call.json as { to?: string } | undefined)?.to ?? '') === OWNER_SIGNUP_EMAIL;
const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Request =>
	new Request(`https://news.dev.pr${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://news.dev.pr', ...headers }, body: new URLSearchParams(fields).toString() });
const get = (path: string, headers: Record<string, string> = {}): Request => new Request(`https://news.dev.pr${path}`, { headers });

interface FetchCall { url: string; init: RequestInit; json: any }
interface MockApi { calls: FetchCall[]; restore(): void }
/** One mock for every provider endpoint used by the module code. */
function mockFetch(handler: (call: FetchCall) => Response | void = () => undefined): MockApi {
	const calls: FetchCall[] = [];
	const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
		const entry: FetchCall = { url: String(url), init: init ?? {}, json: (() => {
			const body = (init ?? {}).body;
			if (typeof body !== 'string') return {};
			if (body.startsWith('{')) { try { return JSON.parse(body); } catch { return { raw: body }; } }
			const out: Record<string, string> = {};
			for (const [k, v] of new URLSearchParams(body)) out[k] = v;
			return out;
		})() };
		calls.push(entry);
		return handler(entry) ?? new Response('{}');
	});
	return { calls, restore: () => mock.mockRestore() };
}
/** Simulated siteverify response: the token claim carries the action of the surface that
 * minted it ('signup' default, 'signin' for magic sign-in) and the widget hostname. */
const turnstileOk = (action = 'signup') => Response.json({ success: true, hostname: 'news.dev.pr', action });
const captchaForm = (extra: Record<string, string> = {}) => ({ 'cf-turnstile-response': 'valid-turnstile-token', ...extra });

async function activated(env: AlertEnv, opts: { email?: string; phrase?: string; language?: string; now?: number } = {}) {
	const email = opts.email ?? 'subscriber@example.org', phrase = opts.phrase ?? 'luma', now = opts.now ?? Date.now();
	await subscribe(env, { email, phrase, language: opts.language ?? 'es', captcha: 'valid', ip: '198.51.100.9' }, now);
	const confirmRow = await getOutbox(env, 'confirm').first<any>();
	const token = JSON.parse(confirmRow.payload as string).token;
	const result = await confirm(env, token, now + 60000);
	if (result.status !== 'confirmed') throw new Error('activation failed');
	const account = await env.DB.prepare('SELECT id FROM alert_accounts WHERE email=?').bind(email).first<any>();
	const watchers = await env.DB.prepare('SELECT id,phrase,tokens,status FROM alert_watchers ORDER BY created_at').bind().all<any>();
	return { token, session: { ...result.session, account_id: account.id }, watcherId: watchers.results[0].id, email, phrase, now: now + 60000 };
}

beforeEach(() => { setPacingForTests({ minIntervalMs: 1, minuteCap: 100 }); });
afterEach(() => { vi.restoreAllMocks(); });

describe('phrase normalization', () => {
	it('reduces phrases to whole lowercase words without AI', () => {
		expect(phraseTokens('  ¡LUMA!! LUMA,   PR-1. ')).toBe('luma pr');
		expect(phraseTokens('<img src=x onerror=alert(1)>').includes('<')).toBe(false);
		expect(phraseTokens('luz')).toBe('luz');
		expect(phraseTokens('a')).toBe('');
		expect(phraseTokens('aa bb cc dd ee ff gg hh ii jj').split(' ')).toHaveLength(8);
	});
});

describe('public signup abuse gating', () => {
	it('requires a verified Turnstile token before writing anything', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch((call) => {
			if (call.url.includes('siteverify')) {
				expect(call.init.method).toBe('POST');
				expect((call.json as any).secret).toBe('turnstile-secret');
				expect((call.json as any).response).toBe('valid');
				expect((call.json as any).remoteip).toBe('203.0.113.5');
				return turnstileOk();
			}
			throw new Error('unexpected provider call');
		});
		try {
			// No challenge: the flow now answers honestly (a captcha-retry verdict) and still
			// writes nothing — no siteverify call, no database row.
			expect((await subscribe(env, { email: 'reader@example.org', phrase: 'luma', captcha: undefined }, 1000)).status).toBe('captcha-retry');
			// Unverified short-circuits before any siteverify fetch or database row.
			expect(mock.calls.filter(c => c.url.includes('siteverify'))).toHaveLength(0);
			expect(await env.DB.prepare('SELECT id FROM alert_accounts').bind().first()).toBeNull();
			// A real token gets server-verified with the configured secret, then accepted into the DB.
			await subscribe(env, { email: 'reader@example.org', phrase: 'luma', captcha: 'valid', ip: '203.0.113.5' }, 1010);
			expect(mock.calls.filter(c => c.url.includes('siteverify'))).toHaveLength(1);
			const account = await env.DB.prepare('SELECT email,status FROM alert_accounts').bind().first<any>();
			expect(account.email).toBe('reader@example.org');
			expect(account.status).toBe('unconfirmed');
			expect((await getOutbox(env, 'confirm').all<any>()).results).toHaveLength(1);
		} finally { mock.restore(); }
	});
	it('answers the honeypot generically and records nothing', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => { throw new Error('no provider calls for bots'); });
		try {
			expect((await subscribe(env, { email: 'bot@example.org', phrase: 'luma', honeypot: 'spam', captcha: 'valid' })).status).toBe('accepted');
			expect(await env.DB.prepare('SELECT id FROM alert_accounts').bind().first()).toBeNull();
		} finally { mock.restore(); }
	});
	it('trips the honeypot at the HTTP layer for tokenless bots from any decoy name', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => { throw new Error('no provider calls for bots'); });
		try {
			for (const decoy of ['x_presencia', 'company', 'website']) {
				const response = await alertsRoute(post('/alerts/signup', { email: 'bot@example.org', phrase: 'luma', [decoy]: 'spam' }), env);
				expect(response?.status).toBe(202);
			}
			expect(mock.calls.filter(c => c.url.includes('siteverify'))).toHaveLength(0);
			expect(await env.DB.prepare('SELECT id FROM alert_accounts').bind().first()).toBeNull();
		} finally { mock.restore(); }
	});
	it('lets a verified token override the honeypot so autofill users are not mistaken for bots', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch((call) => call.url.includes('siteverify') ? Response.json({ success: true, hostname: 'news.dev.pr', action: 'signup' }) : Response.json({}));
		try {
			const response = await alertsRoute(post('/alerts/signup', captchaForm({ email: 'autofill@example.org', phrase: 'luma', x_presencia: 'autofill text' })), env);
			expect(response?.status).toBe(202);
			const account = await env.DB.prepare('SELECT email FROM alert_accounts').bind().first<any>();
			expect(account.email).toBe('autofill@example.org');
		} finally { mock.restore(); }
	});
	it('keeps identical generic answers when unconfigured instead of disabling protections', async () => {
		const { DB } = database(); const env = { ...baseEnv(DB), TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined } as unknown as AlertEnv;
		const mock = mockFetch(() => { throw new Error('must not call providers while unconfigured'); });
		try {
			expect((await subscribe(env, { email: 'a@example.org', phrase: 'luma', captcha: 'valid' })).status).toBe('unavailable');
			expect((await requestSignin(env, { email: 'a@example.org', captcha: 'valid' })).status).toBe('unavailable');
			const response = await alertsRoute(post('/alerts/signup', { email: 'a@example.org', phrase: 'luma' }), env);
			expect(response?.status).toBe(503);
		} finally { mock.restore(); }
	});
	it('reuses a valid confirmation across repeated signups and stays generic', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => turnstileOk());
		try {
			setPacingForTests({ minIntervalMs: 1 });
			for (let i = 0; i < 4; i++) await subscribe(env, { email: 'again@example.org', phrase: 'luma', captcha: 'valid' }, Date.now() + i);
			const rows = (await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_outbox WHERE kind=?').bind('confirm').all<any>()).results;
			expect(rows[0].n).toBe(1);
			// The latest signup still produced a pending watcher, ready for the next day's email.
			expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_watchers WHERE status=?').bind('pending').all<any>()).results[0].n).toBe(1);
		} finally { mock.restore(); setPacingForTests({}); }
	});
	it('replaces the pending watcher when an unconfirmed signup corrects its phrase', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => turnstileOk());
		try {
			const now = Date.now();
			await subscribe(env, { email: 'fix@example.org', phrase: 'first', captcha: 'valid' }, now);
			await subscribe(env, { email: 'fix@example.org', phrase: 'second phrase', captcha: 'valid' }, now + 1000);
			const watchers = (await env.DB.prepare('SELECT tokens FROM alert_watchers').bind().all<any>()).results;
			expect(watchers).toHaveLength(1);
			expect(watchers[0].tokens).toBe('phrase second');
		} finally { mock.restore(); }
	});
	it('sends a fresh sign-in link for an already active address instead of touching it', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => turnstileOk());
		try {
			const { now } = await activated(env, {});
			const watchers = (await env.DB.prepare('SELECT id FROM alert_watchers').bind().all<any>()).results;
			await subscribe(env, { email: 'subscriber@example.org', phrase: 'different', captcha: 'valid' }, now + 1000);
			const signin = await getOutbox(env, 'signin').first<any>();
			expect(signin).toBeTruthy();
			expect(watchers).toHaveLength(1);
			expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_watchers').bind().first<any>()).n).toBe(1);
		} finally { mock.restore(); }
	});
});

describe('siteverify claim validation (action + hostname)', () => {
	it('judges a null or garbage Origin by browser-asserted evidence, and never on manage mutations', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch((call) => call.url.includes('siteverify') ? Response.json({ success: true, hostname: 'news.dev.pr', action: 'signup' }) : Response.json({}));
		try {
			// Origin: null without any browser fetch-metadata evidence is rejected at the origin
			// gate — it is not an identity, sandboxed-frame spam included.
			const nulled = await alertsRoute(post('/alerts/signup', captchaForm({ email: 'webview@example.org', phrase: 'luma' }), { Origin: 'null' }), env);
			expect(nulled?.status).toBe(403);
			expect(await env.DB.prepare('SELECT id FROM alert_accounts').bind().first()).toBeNull();
			expect(await nulled?.text()).toContain('verificación de origen');
			// With Sec-Fetch-Site: same-origin (browser-only header) a null Origin webview passes.
			const evidence = await alertsRoute(post('/alerts/signup', captchaForm({ email: 'webview@example.org', phrase: 'luma' }), { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }), env);
			expect(evidence?.status).toBe(202);
			expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_accounts').bind().first<any>()).toMatchObject({ n: 1 });
		} finally { mock.restore(); }
		const { DB: DB2 } = database(); const env2 = baseEnv(DB2);
		const noMock = mockFetch(() => { throw new Error('a garbage origin never reaches a provider'); });
		try {
			const garbage = await alertsRoute(post('/alerts/signup', { email: 'x@example.org', phrase: 'luma' }, { Origin: 'app://reader' }), env2);
			expect(garbage?.status).toBe(403);
			expect(await garbage?.text()).not.toContain('Si corresponde');
			expect(await env2.DB.prepare('SELECT id FROM alert_accounts').bind().first()).toBeNull();
		} finally { noMock.restore(); }
	});
	it('rejects a verified token whose action does not match the surface, without touching accounts', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch((call) => call.url.includes('siteverify') ? Response.json({ success: true, hostname: 'news.dev.pr', action: 'signin' }) : Response.json({}));
		try {
			// A valid-shaped token whose claim mismatches the surface is a public captcha
			// failure: the verdict is the honest retry, never a fake success, and nothing is
			// touched. The verify call itself was made exactly once.
			expect((await subscribe(env, { email: 'mismatch@example.org', phrase: 'luma', captcha: 'valid' })).status).toBe('captcha-retry');
			expect(mock.calls.filter(c => c.url.includes('siteverify'))).toHaveLength(1);
			expect(await env.DB.prepare('SELECT id FROM alert_accounts').bind().first()).toBeNull();
		} finally { mock.restore(); }
	});
	it('rejects a verified token minted outside the hostname allowlist', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch((call) => call.url.includes('siteverify') ? Response.json({ success: true, hostname: 'other.example', action: 'signup' }) : Response.json({}));
		try {
			expect((await subscribe(env, { email: 'foreign@example.org', phrase: 'luma', captcha: 'valid' })).status).toBe('captcha-retry');
			expect(await env.DB.prepare('SELECT id FROM alert_accounts').bind().first()).toBeNull();
		} finally { mock.restore(); }
	});
	it('pauses the public forms when the hostname allowlist is missing', async () => {
		const { DB } = database();
		const env = { ...baseEnv(DB), TURNSTILE_HOSTNAMES: undefined } as unknown as AlertEnv;
		const mock = mockFetch(() => { throw new Error('no siteverify call is possible without an allowlist'); });
		try {
			const signinPage = await alertsRoute(get('/alerts'), env);
			expect(signinPage?.text()).not.toContain('cf-turnstile');
			// Missing allowlist is an unverifyable challenge: honest retry verdict, no DB writes.
			expect((await subscribe(env, { email: 'empty@example.org', phrase: 'luma', captcha: 'valid' })).status).toBe('captcha-retry');
			expect(await env.DB.prepare('SELECT id FROM alert_accounts').bind().first()).toBeNull();
			expect(mock.calls.filter(c => c.url.includes('siteverify'))).toHaveLength(0);
		} finally { mock.restore(); }
	});
	it('renders the widgets with the per-surface action claims', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const signinHtml = (await (await alertsRoute(get('/alerts'), env))?.text()) ?? '';
		expect(signinHtml).toContain('cf-turnstile');
		expect(signinHtml).toContain('data-action="signin"');
		expect(signinHtml).not.toContain('data-action="signup"');
	});
});

describe('double opt-in, tokens and sessions', () => {
	it('stores only hashes, activates via one-time link and opens a scoped session', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => turnstileOk());
		try {
			const now = Date.now();
			const email = 'confirm@example.org';
			await subscribe(env, { email, phrase: 'energia', language: 'en', captcha: 'valid' }, now);
			const stored = await env.DB.prepare('SELECT token_hash FROM alert_tokens WHERE purpose=?').bind('confirm').first<any>();
			const payload = JSON.parse((await getOutbox(env, 'confirm').first<any>()).payload);
			expect(stored.token_hash).not.toBe(payload.token);
			const result = await confirm(env, payload.token, now + 60000);
			expect(result.status).toBe('confirmed');
			const account = await env.DB.prepare('SELECT status FROM alert_accounts WHERE email=?').bind(email).first<any>();
			expect(account.status).toBe('active');
			const watcher = await env.DB.prepare('SELECT status,baseline,scan_cursor FROM alert_watchers').bind().first<any>();
			expect(watcher.status).toBe('active');
			expect(watcher.baseline).toBe(now + 60000);
			expect(watcher.scan_cursor).toBe(now + 60000);
			const session = await sessionFromCookie(env, (result as any).session.secret, now + 60000);
			expect(session?.account_id).toBeTruthy();
			// Replay of the consumed token brings nothing: no activation again, no session.
			const replay = await confirm(env, payload.token, now + 61000);
			expect(replay.status).toBe('processed');
			const page = await alertsRoute(get(`/alerts/confirm?token=${payload.token}`), env);
			expect(page?.status).toBe(200);
			expect(await page?.text()).toContain('Este mensaje no confirma');
			expect(page?.headers.get('Set-Cookie')).toBeNull();
		} finally { mock.restore(); }
	});
	it('confirmation HTTP redemption rotates into a secure cookie and a clean URL', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => turnstileOk());
		try {
			const email = 'cookie@example.org';
			await subscribe(env, { email, phrase: 'playa', captcha: 'valid' }, Date.now());
			const payload = JSON.parse((await getOutbox(env, 'confirm').first<any>()).payload);
			const response = await alertsRoute(get(`/alerts/confirm?token=${payload.token}`), env);
			expect(response?.status).toBe(303);
			expect(response?.headers.get('Location')).toBe('/alerts?lang=es');
			const cookie = response?.headers.get('Set-Cookie') ?? '';
			expect(cookie.startsWith('alerts_session=')).toBe(true);
			expect(cookie).toContain('HttpOnly');
			expect(cookie).toContain('SameSite=Lax');
			expect(cookie).toContain('Secure');
			expect(cookie).toContain('Path=/');
			const managed = await alertsRoute(get('/alerts', { Cookie: cookie.split(';')[0] }), env);
			const managedHtml = await managed!.text();
			for (const label of ['playa', 'Crear alerta', 'Guardar', 'Pausar', 'Eliminar']) expect(managedHtml).toContain(label);
			const replay = await alertsRoute(get(`/alerts/confirm?token=${payload.token}`, { Cookie: cookie.split(';')[0] }), env);
			expect(replay?.headers.get('Location')).toBe('/alerts?lang=es');
			expect(replay?.headers.get('Set-Cookie')).toBeNull();

			const html = await response?.text();
			expect(html).not.toContain('token=');
		} finally { mock.restore(); }
	});
	it('magic sign-in is single-use, expiring and generic for unknown addresses', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		let captchaCalls = 0;
		// First token belongs to the signup flow inside activated(); later tokens to sign-in.
		const mock = mockFetch(() => turnstileOk(++captchaCalls === 1 ? 'signup' : 'signin'));
		try {
			setPacingForTests({ minIntervalMs: 1 });
			const { now, session } = await activated(env, {});
			const before = (await getOutbox(env, 'signin').all<any>()).results.length;
			expect((await requestSignin(env, { email: 'ghost@example.org', captcha: 'valid' }, now)).status).toBe('accepted');
			expect((await getOutbox(env, 'signin').all<any>()).results.length).toBe(before);
			expect((await requestSignin(env, { email: 'subscriber@example.org', captcha: 'valid' }, now + 1000)).status).toBe('accepted');
			const signin = await getOutbox(env, 'signin').first<any>();
			const token = JSON.parse(signin.payload).token;
			const magic = await useMagicLink(env, token, 'signin', now + 2000);
			expect(magic.status).toBe('session');
			expect((await useMagicLink(env, token, 'signin', now + 3000)).status).toBe('processed');
			// manage tokens (purpose 'manage') cannot pass as sign-in links.
			expect((await useMagicLink(env, token, 'manage', now + 3000)).status).toBe('processed');
			const response = await alertsRoute(get(`/alerts/in?token=${token}`), env);
			expect(response?.status).toBe(200);
			expect(response?.headers.get('Set-Cookie')).toBeNull();
			// The redeemed link created exactly the two sessions seen above (session from confirm, one from magic).
			const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_sessions').bind().first<any>();
			expect(count.n).toBe(2);
			expect(session).toBeTruthy();
		} finally { mock.restore(); setPacingForTests({}); }
	});
	it('unconfirmed accounts receive no sign-in mail', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		let captchaCalls = 0;
		// First token belongs to the signup flow; the later one to the sign-in request.
		const mock = mockFetch(() => turnstileOk(++captchaCalls === 1 ? 'signup' : 'signin'));
		try {
			await subscribe(env, { email: 'pending@example.org', phrase: 'bar', captcha: 'valid' }, Date.now());
			expect((await requestSignin(env, { email: 'pending@example.org', captcha: 'valid' })).status).toBe('accepted');
			expect(await getOutbox(env, 'signin').first()).toBeNull();
		} finally { mock.restore(); }
	});
});

describe('manage: isolation, CSRF, pause/delete, unsubscribe-all', () => {
	it('mutates only own watchers behind a per-session CSRF token', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => turnstileOk());
		try {
			setPacingForTests({ minIntervalMs: 1 });
			const a = await activated(env, { email: 'a@example.org', phrase: 'surf' });
			const b = await activated(env, { email: 'b@example.org', phrase: 'surf', now: a.now + 1000 });
			const now = b.now + 1000;
			// Wrong CSRF is rejected outright.
			const badCsrf = await alertsRoute(post('/alerts/watcher', { csrf: 'nope', action: 'add', phrase: 'luz' }, { Cookie: `alerts_session=${a.session.secret}` }), env);
			expect(badCsrf?.status).toBe(403);
			// Wrong origin is rejected.
			const wrongOrigin = await alertsRoute(new Request('https://news.dev.pr/alerts/watcher?lang=es', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example', Cookie: `alerts_session=${a.session.secret}` }, body: new URLSearchParams({ csrf: a.session.csrf ?? 'x', action: 'add', phrase: 'luz' }).toString() }), env);
			expect(wrongOrigin?.status).toBe(403);
			// No cookie at all: session-gated.
			const anonymous = await alertsRoute(post('/alerts/watcher', { csrf: 'x', action: 'add', phrase: 'luz' }), env);
			expect(anonymous?.status).toBe(401);
			// Isolation: B cannot mutate A's watcher even with a valid B session + B CSRF.
			const cross = await alertsRoute(post('/alerts/watcher', { csrf: b.session.csrf ?? '', action: 'pause', id: a.watcherId }, { Cookie: `alerts_session=${b.session.secret}` }), env);
			expect(cross?.status).toBe(303);
			expect((cross?.headers.get('Location') ?? '').includes('error=1')).toBe(true);
			expect((await env.DB.prepare('SELECT status FROM alert_watchers WHERE id=?').bind(a.watcherId).first<any>()).status).toBe('active');
			// A adds, edits, pauses, deletes its own.
			const ok = await alertsRoute(post('/alerts/watcher', { csrf: a.session.csrf ?? '', action: 'add', phrase: 'farol luma' }, { Cookie: `alerts_session=${a.session.secret}` }), env);
			expect(ok?.status).toBe(303);
			const managed = await manageWatcher(env, a.session.account_id ?? 'nope', 'pauseall', '', '', now);
			expect(managed).toBe('ok');
			const paused = (await env.DB.prepare('SELECT status FROM alert_watchers WHERE account_id=?').bind(a.session.account_id).all<any>()).results;
			expect(paused.every(w => w.status === 'paused')).toBe(true);
			expect(await alertsRoute(get('/alerts', { Cookie: `alerts_session=${a.session.secret}` }), env).then(r => r?.text()))
				.toContain('Pausar todas');
			await manageWatcher(env, a.session.account_id, 'resume', (await env.DB.prepare('SELECT id FROM alert_watchers WHERE account_id=?').bind(a.session.account_id).first<any>()).id, '', now);
		} finally { mock.restore(); setPacingForTests({}); }
	});
	it('unsubscribe-all via the mailed link closes everything for real', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => turnstileOk());
		try {
			setPacingForTests({ minIntervalMs: 1 });
			const { session } = await activated(env, {});
			const accountId = (await env.DB.prepare('SELECT id FROM alert_accounts').bind().first<any>()).id;
			const token = await unsubscribeToken(env, accountId);
			for (const method of ['GET', 'POST']) {
				const request = new Request(`https://news.dev.pr/alerts/out?token=${token}`, { method });
				const response = await alertsRoute(request, env);
				expect(response?.status).toBe(200);
			}
			const closed = await env.DB.prepare('SELECT status FROM alert_accounts WHERE id=?').bind(accountId).first<any>();
			expect(closed.status).toBe('closed');
			expect(await env.DB.prepare('SELECT id FROM alert_watchers').bind().first()).toBeNull();
			expect(await sessionFromCookie(env, session.secret)).toBeNull();
			// Unknown link: identical generic page, no error leaks.
			const unknown = await alertsRoute(get(`/alerts/out?token=${'0'.repeat(64)}`), env);
			expect(unknown?.status).toBe(200);
		} finally { mock.restore(); setPacingForTests({}); }
	});
});

const notifySends = (calls: FetchCall[]) => calls.filter(c => c.url.includes('/emails/outbound') && /^Alerta/.test(String((c.json ?? {}).subject ?? '')));

describe('matching watermark, dedup and batching', () => {

	it('notifies once per person per article across alerts, translations arriving later included', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => turnstileOk());
		try {
			setPacingForTests({ minIntervalMs: 1, minuteCap: 100, dailyCap: 100000 });
			const { now, session } = await activated(env, { phrase: 'luma' });
			const accountId = session.account_id;
			// Two independent alerts sharing one account; both watch the same articles.
			await manageWatcher(env, accountId, 'add', '', 'luma', now + 60000);
			// A third alert whose phrase only exists in a translation that has not arrived.
			await manageWatcher(env, accountId, 'add', '', 'signs the budget', now + 120000);
			await runAlertSweep(env, now + 120000); // no articles yet: cursors seed at baselines
			// Old stories never notify, even when freshly ingested.
			await insertArticle(env, item('https://old.example/2', 'LUMA repara el servicio', now - 1000), now - 999);
			await insertArticle(env, item('https://fresh.example/1', 'LUMA repara el servicio', now + 300000), now + 300000);
			await insertArticle(env, item('https://fresh.example/3', 'Gobernador firma el presupuesto', now + 400000), now + 400000);
			await runAlertSweep(env, now + 420000);
			const notified = (await env.DB.prepare('SELECT url FROM alert_notified ORDER BY url').bind().all<any>()).results.map((r: any) => r.url);
			expect(notified).toEqual(['https://fresh.example/1']); // old story excluded; translation pending
			const rematch = await runAlertSweep(env, now + 480000);
			expect(rematch.matched).toBe(0); // re-matches never re-notify
			expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_notified').bind().first<any>()).n).toBe(1);
			// Translation arrives after collection; the lookback window still finds it — once.
			await env.DB.prepare('UPDATE articles SET translation=? WHERE url=?').bind(JSON.stringify({
				originalTitle: 'Gobernador firma el presupuesto',
				originalSummary: 'Extracto base.',
				title: 'Governor signs the budget',
				summary: 'The governor signs the budget.',
			}), 'https://fresh.example/3').run();
			const translated = await runAlertSweep(env, now + 540000);
			expect(translated.matched).toBe(1);
			const urls = (await env.DB.prepare('SELECT url FROM alert_notified ORDER BY url').bind().all<any>()).results.map((r: any) => r.url);
			expect(urls).toEqual(['https://fresh.example/1', 'https://fresh.example/3']);
			await runAlertSweep(env, now + 600000);
			expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_notified').bind().first<any>()).n).toBe(2);
		} finally { mock.restore(); setPacingForTests({}); }
	});

	it('batches to one email per hour per address, with all matches and no duplicates', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const calls: FetchCall[] = [];
		const mock = mockFetch((call) => {
			calls.push(call);
			if (call.url.includes('/emails/outbound')) return Response.json({ id: 'log-x', message_id: '<m>' });
			if (call.url.includes('siteverify')) return turnstileOk();
			if (call.url.includes('/logs')) return Response.json({ logs: [] });
			return Response.json({});
		});
		try {
			setPacingForTests({ minIntervalMs: 1, minuteCap: 100, dailyCap: 100000 });
			const { now } = await activated(env, {});
			await insertArticle(env, item('https://one.example/1', 'LUMA anuncia plan', now + 1000), now + 1000);
			await insertArticle(env, item('https://one.example/2', 'Otra noticia de LUMA', now + 1500), now + 1500);
			const sweepOne = await runAlertSweep(env, now + 2000);
			expect(sweepOne.flushed).toBe(1);
			expect(notifySends(calls)).toHaveLength(1); // batched, sent once
			const notifyRow = (await getOutbox(env, 'notify').first<any>());
			expect(JSON.parse(notifyRow.payload).items).toHaveLength(2);
			// Within the hour: a new match queues but cannot leave early.
			await insertArticle(env, item('https://one.example/3', 'LUMA otra vez', now + 60000), now + 60000);
			const sweepTwo = await runAlertSweep(env, now + 61000);
			expect(sweepTwo.flushed).toBe(0);
			expect(notifySends(calls)).toHaveLength(1);
			expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_queue').bind().first<any>()).n).toBe(1);
			// After the hour: a second batch leaves; still exactly one mention per article.
			await runAlertSweep(env, now + 3605000);
			expect(notifySends(calls)).toHaveLength(2);
			expect((await env.DB.prepare('SELECT url FROM alert_notified WHERE url=?').bind('https://one.example/3').all<any>()).results).toHaveLength(1);
			// Manage + unsubscribe links ride inside the notification email.
			const html = notifySends(calls).map(c => String((c.json ?? {}).html ?? '')).find(h => h.includes('/alerts/m?token='));
			expect(html).toContain('/alerts/out?token=');
		} finally { mock.restore(); setPacingForTests({}); }
	});
});

describe('provider outbox: pacing, uncertain resolution, throttle, rejections', () => {
	const outboundCalls = (calls: FetchCall[]) => calls.filter(c => c.url.includes('/emails/outbound'));

	it('delivers the confirmation mail immediately at signup and never resends it', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch((call) => {
			if (call.url.includes('/emails/outbound')) {
				expect((call.json as any).subject).toContain('Confirma');
				return Response.json({ id: 'c-remote' });
			}
			if (call.url.includes('siteverify')) return turnstileOk();
			return Response.json({});
		});
		try {
			setPacingForTests({ minIntervalMs: 1, minuteCap: 100, dailyCap: 100000 });
			await subscribe(env, { email: 'instant@example.org', phrase: 'luma', captcha: 'valid' }, Date.now());
			const confirmRow = await env.DB.prepare('SELECT state,provider_ref FROM alert_outbox WHERE kind=?').bind('confirm').first<any>();
			expect(confirmRow?.state).toBe('sent'); // no cron needed: sent in the request path
			expect(confirmRow?.provider_ref).toBe('c-remote');
			// A later sweep finds nothing pending: a delivered confirm mail never resends.
			await runAlertSweep(env, Date.now() + 1000);
			expect(outboundCalls(mock.calls)).toHaveLength(1);
		} finally { mock.restore(); setPacingForTests({}); }
	});
	it('waits for a busy pacing slot and sends before any cron', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		setPacingForTests({ minIntervalMs: 30 });
		const mock = mockFetch(call => call.url.includes('siteverify') ? turnstileOk() : Response.json({ id: 'paced' }));
		try {
			const now = Date.now();
			await env.DB.prepare("UPDATE alert_pace SET last_send=?,minute=?,minute_count=1 WHERE id='pace'").bind(now, Math.floor(now / 60000)).run();
			await subscribe(env, { email: 'queued@example.org', phrase: 'luma', captcha: 'valid' }, now);
			expect(Date.now() - now).toBeGreaterThanOrEqual(25);
			expect((await getOutbox(env, 'confirm').first<any>()).state).toBe('sent');
			expect(outboundCalls(mock.calls)).toHaveLength(1);
			await runAlertSweep(env, Date.now() + 9000);
			expect(outboundCalls(mock.calls)).toHaveLength(1);
		} finally { mock.restore(); }
	});
	it('sends the sign-in link mail immediately too', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch((call) => {
			if (call.url.includes('/emails/outbound')) return Response.json({ id: 's-remote' });
			// The first verify is the signup inside activated(); later ones are sign-in requests.
			if (call.url.includes('siteverify')) return Response.json({ success: true, hostname: 'news.dev.pr', action: ++verifyCalls === 1 ? 'signup' : 'signin' });
			return Response.json({});
		});
		let verifyCalls = 0;
		try {
			setPacingForTests({ minIntervalMs: 1, minuteCap: 100, dailyCap: 100000 });
			await activated(env, {});
			await requestSignin(env, { email: 'subscriber@example.org', captcha: 'valid' }, Date.now() + 1000);
			const signinRow = await env.DB.prepare('SELECT state,provider_ref FROM alert_outbox WHERE kind=?').bind('signin').first<any>();
			expect(signinRow?.state).toBe('sent');
			expect(signinRow?.provider_ref).toBe('s-remote');
		} finally { mock.restore(); setPacingForTests({}); }
	});

	it('never resends on ambiguity until logs prove absence; sends again once when proven absent', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		let notifyAttempts = 0;
		const mock = mockFetch((call) => {
			if (call.url.includes('/emails/outbound')) {
				if (/^Confirma/.test(String((call.json ?? {}).subject ?? '')) || isOwnerSend(call)) return Response.json({ id: 'c1' });
				notifyAttempts++;
				if (notifyAttempts === 1) throw new TypeError('network down'); // acceptance unknown
				return Response.json({ id: 'n1' });
			}
			if (call.url.includes('siteverify')) return turnstileOk();
			if (call.url.includes('/logs')) return Response.json({ logs: [] });
			return Response.json({});
		});
		try {
			setPacingForTests({ minIntervalMs: 1, minuteCap: 100, dailyCap: 100000 });
			const { now } = await activated(env, {});
			await insertArticle(env, item('https://amb.example/1', 'LUMA y la incertidumbre', now + 1000), now + 1000);
			await runAlertSweep(env, now + 2000);
			expect(notifyAttempts).toBe(1);
			const row = (await getOutbox(env, 'notify').first<any>());
			expect(row.state).toBe('uncertain');
			expect(row.attempts).toBe(1);
			// The next sweep must not resend while the uncertainty is unresolved.
			await runAlertSweep(env, now + 3000);
			expect(notifyAttempts).toBe(1);
			// Age the attempt past the probe grace; the provider says nothing was accepted.
			await env.DB.prepare('UPDATE alert_outbox SET attempt_at=? WHERE state=?').bind(now + 1000 - 121000, 'uncertain').run();
			await runAlertSweep(env, now + 122000);
			expect(notifyAttempts).toBe(1); // resolution flips the state first; the resend lease holds
			expect((await getOutbox(env, 'notify').first<any>()).state).toBe('pending');
			await runAlertSweep(env, now + 423000); // past the five-minute resend lease
			expect(notifyAttempts).toBe(2);
			expect((await getOutbox(env, 'notify').first<any>()).state).toBe('sent');
			await runAlertSweep(env, now + 500000);
			expect(notifyAttempts).toBe(2); // delivered rows are never resent
		} finally { mock.restore(); setPacingForTests({}); }
	});

	it('proof of acceptance from the logs marks the row sent instead of duplicating', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch((call) => {
			if (call.url.includes('/emails/outbound')) {
				if (/^Confirma/.test(String((call.json ?? {}).subject ?? '')) || isOwnerSend(call)) return Response.json({ id: 'c1' });
				throw new TypeError('cut mid-request');
			}
			if (call.url.includes('siteverify')) return turnstileOk();
			if (call.url.includes('/logs/search')) return Response.json({ logs: [{ id: 'log-proof', status: 'QUEUED' }] });
			return Response.json({ logs: [] });
		});
		try {
			setPacingForTests({ minIntervalMs: 1, minuteCap: 100, dailyCap: 100000 });
			const { now } = await activated(env, {});
			await insertArticle(env, item('https://proof.example/1', 'LUMA con prueba', now + 1000), now + 1000);
			await runAlertSweep(env, now + 2000);
			expect((await getOutbox(env, 'notify').first<any>()).state).toBe('uncertain');
			await env.DB.prepare('UPDATE alert_outbox SET attempt_at=? WHERE state=?').bind(now + 1000 - 121000, 'uncertain').run();
			await runAlertSweep(env, now + 122000);
			expect((await getOutbox(env, 'notify').first<any>()).state).toBe('sent');
			expect(outboundCalls(mock.calls).filter(c => !/^Confirma/.test(String((c.json ?? {}).subject)) && !isOwnerSend(c))).toHaveLength(1); // proven present: no second subscriber send
		} finally { mock.restore(); setPacingForTests({}); }
	});

	it('honors Retry-After on 429 without consuming attempts and stops the batch', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const calls: FetchCall[] = [];
		const mock = mockFetch((call) => {
			calls.push(call);
			if (call.url.includes('/emails/outbound')) {
				if (/^Confirma/.test(String((call.json ?? {}).subject ?? '')) || isOwnerSend(call)) return Response.json({ id: 'c1' });
				return Response.json({ id: 'x' }, { status: 429, headers: { 'Retry-After': '120' } });
			}
			if (call.url.includes('siteverify')) return turnstileOk();
			return Response.json({ logs: [] });
		});
		try {
			setPacingForTests({ minIntervalMs: 1, minuteCap: 100, dailyCap: 100000 });
			const { now } = await activated(env, {});
			await insertArticle(env, item('https://th.example/1', 'LUMA anuncia plan', now + 1000), now + 1000);
			await runAlertSweep(env, now + 2000);
			const row = (await env.DB.prepare('SELECT state,attempts,lease_until FROM alert_outbox WHERE kind=?').bind('notify').first<any>());
			expect(row.state).toBe('pending');
			expect(row.attempts).toBe(0);
			// Retry-After resolves against the real clock, so the assertion does too.
			expect(row.lease_until).toBeGreaterThanOrEqual(Date.now() + 118000);
			// While the throttle lease holds, nothing new goes out.
			await insertArticle(env, item('https://th.example/2', 'LUMA otra vez', now + 2500), now + 2500);
			await runAlertSweep(env, now + 3000);
			expect(notifySends(calls)).toHaveLength(1);
		} finally { mock.restore(); setPacingForTests({}); }
	});

	it('treats definite 4xx rejections as terminal and keeps the identity honest', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const calls: FetchCall[] = [];
		const mock = mockFetch((call) => {
			calls.push(call);
			if (call.url.includes('/emails/outbound')) {
				if (/^Confirma/.test(String((call.json ?? {}).subject ?? '')) || isOwnerSend(call)) return Response.json({ id: 'c1' });
				expect(call.url).toBe('https://api.improvmx.com/v4/domains/code.pr/emails/outbound');
				expect((call.init.headers as any).Authorization).toBe('Basic ' + Buffer.from('api:improv-fake-key').toString('base64'));
				expect((call.json as any).from).toBe('prnews');
				expect((call.json as any).reply_to).toBe('prnews@code.pr');
				expect((call.json as any).to).toBe('subscriber@example.org');
				return Response.json({ message: 'rejected' }, { status: 403 });
			}
			if (call.url.includes('siteverify')) return turnstileOk();
			return Response.json({ logs: [] });
		});
		try {
			setPacingForTests({ minIntervalMs: 1, minuteCap: 100, dailyCap: 100000 });
			const { now } = await activated(env, {});
			await insertArticle(env, item('https://rej.example/1', 'LUMA y el rechazo', now + 1000), now + 1000);
			const sweep = await runAlertSweep(env, now + 2000);
			expect(sweep.sent).toBe(0); // the confirmation already left at signup; only the notification stayed, and it was refused
			expect((await getOutbox(env, 'notify').first<any>()).state).toBe('failed');
			await runAlertSweep(env, now + 3000);
			expect(notifySends(calls)).toHaveLength(1); // failed rows are terminal
			// No Resend path exists anywhere in the alerts module.
			expect(mock.calls.some(c => c.url.includes('resend.com'))).toBe(false);
		} finally { mock.restore(); setPacingForTests({}); }
	});

	it('marks outbox rows unresolved only after attempts and age are exhausted, then prunes', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch((call) => {
			if (call.url.includes('/emails/outbound')) {
				if (/^Confirma/.test(String((call.json ?? {}).subject ?? '')) || isOwnerSend(call)) return Response.json({ id: 'c1' });
				throw new TypeError('down');
			}
			if (call.url.includes('siteverify')) return turnstileOk();
			return Response.json({ logs: [] }); // probes find nothing
		});
		try {
			setPacingForTests({ minIntervalMs: 1, minuteCap: 100, dailyCap: 100000 });
			const { now } = await activated(env, {});
			await insertArticle(env, item('https://res.example/1', 'LUMA en el tiempo', now + 1000), now + 1000);
			await runAlertSweep(env, now + 2000);
			expect((await getOutbox(env, 'notify').first<any>()).state).toBe('uncertain');
			// Force the row onto its last attempt, aged past the probe grace.
			await env.DB.prepare('UPDATE alert_outbox SET attempts=5,attempt_at=?,created_at=? WHERE kind=?').bind(now + 1000 - 121000, now - 1000, 'notify').run();
			await runAlertSweep(env, now + 122000);
			expect((await getOutbox(env, 'notify').first<any>()).state).toBe('unresolved');
			// Terminal rows vanish after the mail-retention window; notify prunes stay bounded.
			await env.DB.prepare('UPDATE alert_outbox SET created_at=? WHERE kind=?').bind(now - 2 * 86400000, 'notify').run();
			await runAlertSweep(env, now + 130000);
			expect(await getOutbox(env, 'notify').first()).toBeNull();
		} finally { mock.restore(); setPacingForTests({}); }
	});
});

describe('HTTP responses: generic, private, no token leakage', () => {
	it('a failed challenge gets the honest bilingual retry page, not a fake success; GET stays method-protected', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch((call) => call.url.includes('siteverify') ? Response.json({ success: false, 'error-codes': ['invalid-input-response'] }) : Response.json({ logs: [] }));
		try {
			const response = await alertsRoute(post('/alerts/signup', { email: 'seeker@example.org', phrase: 'luma', 'cf-turnstile-response': 'expired-challenge-abc123' }), env);
			expect(response?.status).toBe(400);
			const html = await response?.text();
			expect(html).toContain('No pudimos verificar');
			expect(html).toContain('No se registró nada');
			// Public captcha failure is not email enumeration: no fake "if eligible" success and
			// no account claim of any kind; the dead token value is never echoed.
			expect(html).not.toContain('Si corresponde');
			expect(html).not.toContain('expired-challenge-abc123');
			// Retained input is the visitor's own, escaped; a fresh challenge rides along.
			expect(html).toContain('value="seeker@example.org"');
			expect(html).toContain('cf-turnstile');
			// The English edition carries its own honest wording.
			const english = await alertsRoute(post('/alerts/signup?lang=en', { email: 'seeker@example.org', phrase: 'luma', 'cf-turnstile-response': '' }), env);
			expect(await english?.text()).toContain('Nothing was recorded');
			expect(await alertNoStore(response)).toBe(true);
			const methoded = await alertsRoute(get('/alerts/signup'), env);
			expect(methoded?.status).toBe(405);
		} finally { mock.restore(); }
	});
	it('manage page needs the session; token pages stay no-store, noindex and beacon-free', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => turnstileOk());
		try {
			setPacingForTests({ minIntervalMs: 1 });
			const { session } = await activated(env, {});
			const empty = await alertsRoute(get('/alerts'), env);
			expect(empty?.headers.get('Cache-Control')).toBe('no-store');
			expect(empty?.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
			expect(empty?.headers.get('Referrer-Policy')).toBe('no-referrer');
			expect(await empty?.text()).not.toContain('cloudflareinsights');
			const page = await alertsRoute(get('/alerts', { Cookie: `alerts_session=${session.secret}` }), env);
			const html = await page?.text();
			expect(html).toContain('Mis alertas');
			expect(html).toContain('luma');
			expect(html).not.toContain(session.secret);
		} finally { mock.restore(); setPacingForTests({}); }
	});
	it('head requests are served without bodies', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const response = await alertsRoute(new Request('https://news.dev.pr/alerts', { method: 'HEAD' }), env);
		expect(await response?.text()).toBe('');
		expect(response?.headers.get('Cache-Control')).toBe('no-store');
	});
});
describe('same-origin gate: native form reproduction, redirects, aliases and attacks', () => {
	it.each([
		['normal native form post (Origin + Referer + Sec-Fetch-Site)', { Origin: 'https://news.dev.pr', Referer: 'https://news.dev.pr/signup', 'Sec-Fetch-Site': 'same-origin' }, 202],
		['no-referrer page: Referrer-Policy strips Referer, Origin remains', { Origin: 'https://news.dev.pr', 'Sec-Fetch-Site': 'same-origin' }, 202],
		['origin-stripping privacy mode leaves only browser fetch metadata', { 'Sec-Fetch-Site': 'same-origin' }, 202],
		['older browsers: matching Referer, no Origin, no fetch metadata', { Referer: 'https://news.dev.pr/signup' }, 202],
		['explicit cross-site Origin', { Origin: 'https://evil.example', Referer: 'https://evil.example/', 'Sec-Fetch-Site': 'cross-site' }, 403],
		['foreign Origin, no fetch metadata', { Origin: 'https://evil.example' }, 403],
		['no Origin but cross-site fetch metadata', { 'Sec-Fetch-Site': 'cross-site' }, 403],
		['different scheme is a different origin, no evidence', { Origin: 'http://news.dev.pr' }, 403],
		['different port is a different origin', { Origin: 'https://news.dev.pr:8443' }, 403],
		['site alias without browser evidence', { Origin: 'https://www.news.dev.pr' }, 403],
	])('%s is judged at the gate', async (_name, headers, expected) => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch((call) => call.url.includes('siteverify') ? turnstileOk() : Response.json({}));
		try {
			const response = await alertsRoute(post('/alerts/signup', captchaForm({ email: 'gate@example.org', phrase: 'luma' }), headers), env);
			expect(response?.status).toBe(expected);
			if (expected === 202) {
				expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_accounts').bind().first<any>()).toMatchObject({ n: 1 });
			} else {
				// Blocked never pretends success: the actionable origin-check page, nothing recorded.
				const html = await response?.text();
				expect(html).toContain('verificación de origen');
				expect(html).not.toContain('Si corresponde');
				expect(await env.DB.prepare('SELECT id FROM alert_accounts').bind().first()).toBeNull();
				expect(mock.calls.filter(c => c.url.includes('siteverify'))).toHaveLength(0);
			}
		} finally { mock.restore(); }
	});

	it('lets a scheme-rewritten same host+port post and the www alias pass only with browser-asserted evidence', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch((call) => call.url.includes('siteverify') ? turnstileOk() : Response.json({}));
		try {
			// No proxy behaviour is assumed: the scheme rewrite rides only on Sec-Fetch-Site.
			const rewritten = await alertsRoute(post('/alerts/signup', captchaForm({ email: 'proxy@example.org', phrase: 'luma' }), { Origin: 'http://news.dev.pr', 'Sec-Fetch-Site': 'same-origin' }), env);
			expect(rewritten?.status).toBe(202);
			// www.news.dev.pr alias with browser-asserted same-site evidence.
			const alias = await alertsRoute(post('/alerts/signup', captchaForm({ email: 'alias@example.org', phrase: 'luma' }), { Origin: 'https://www.news.dev.pr', Referer: 'https://www.news.dev.pr/signup', 'Sec-Fetch-Site': 'same-site' }), env);
			expect(alias?.status).toBe(202);
		} finally { mock.restore(); }
	});

	it('curl-class clients without origin evidence keep the legacy posture and meet the captcha gate', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => { throw new Error('no token, no siteverify call'); });
		try {
			const response = await alertsRoute(post('/alerts/signup', { email: 'curl@example.org', phrase: 'luma' }), env);
			// Not blocked at the gate; stopped honestly by missing verification. No rows.
			expect(response?.status).toBe(400);
			expect(await response?.text()).toContain('No pudimos verificar');
			expect(await env.DB.prepare('SELECT id FROM alert_accounts').bind().first()).toBeNull();
		} finally { mock.restore(); }
	});
});

describe('captcha retry honesty vs enumeration', () => {
	it('missing, failed and network-broken challenges answer the retry page for signup and signin, recording nothing', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch((call) => {
			if (call.url.includes('siteverify')) throw new TypeError('network down'); // transport failure
			return Response.json({ logs: [] });
		});
		try {
			const cases: [string, Record<string, string>, number][] = [
				['/alerts/signup', { email: 'missing@example.org', phrase: 'luma' }, 400], // no token at all
				['/alerts/signup', { email: 'failed@example.org', phrase: 'luma', 'cf-turnstile-response': 'expired-token-xyz' }, 400], // network-broken verify
				['/alerts/signin', { email: 'signin@example.org' }, 400], // no token at all
			];
			for (const [path, fields, expected] of cases) {
				const response = await alertsRoute(post(path, fields), env);
				expect(response?.status).toBe(expected);
				const html = await response?.text();
				expect(html).toContain('No pudimos verificar');
				expect(html).not.toContain('Si corresponde');
				// The raw submitted challenge value ('expired-token-xyz') is never echoed.
				expect(html).not.toContain(fields['cf-turnstile-response'] ?? 'expired-token-xyz-placeholder');
				expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_accounts').bind().first<any>()).toMatchObject({ n: 0 });
				expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_outbox').bind().first<any>()).toMatchObject({ n: 0 });
			}
		} finally { mock.restore(); }
	});

	it('the retry page escapes retained user input before echoing it', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => { throw new Error('no token, no provider calls'); });
		try {
			const response = await alertsRoute(post('/alerts/signup', {
				email: 'x"onfocus=alert(1)\'@e.org', phrase: '"><svg onload=alert(1)>', 'cf-turnstile-response': '', 'x_presencia': '',
			}), env);
			expect(response?.status).toBe(400);
			const html = await response?.text();
			expect(html).toContain('value="x&quot;onfocus=alert(1)&#39;@e.org"');
			expect(html).toContain('&quot;&gt;&lt;svg onload=alert(1)&gt;');
			// Attribute break-out content and live markup must never survive raw.
			expect(html).not.toContain('<svg onload');
			expect(html).not.toContain('"x"onfocus');
		} finally { mock.restore(); }
	});

	it('after a valid challenge, account-specific outcomes stay identical for unknown and existing addresses', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch((call) => call.url.includes('siteverify') ? turnstileOk() : Response.json({}));
		try {
			setPacingForTests({ minIntervalMs: 1 });
			const { session, now } = await activated(env, {}); // subscriber@example.org becomes active
			const unknown = await alertsRoute(post('/alerts/signup', captchaForm({ email: 'ghost@example.org', phrase: 'luma' }), { Origin: 'https://news.dev.pr', 'Sec-Fetch-Site': 'same-origin' }), env);
			const existing = await alertsRoute(post('/alerts/signup', captchaForm({ email: 'subscriber@example.org', phrase: 'luma' }), { Origin: 'https://news.dev.pr', 'Sec-Fetch-Site': 'same-origin' }), env);
			expect(unknown?.status).toBe(202);
			expect(existing?.status).toBe(202);
			const unknownText = await unknown?.text(), existingText = await existing?.text();
			// Byte-identical public answers: no address state ever leaks after a valid challenge.
			expect(existingText).toBe(unknownText);
			expect(unknownText).toContain('Si corresponde');
			// Nothing changed about the active account's watchers (sign-in mail path only).
			expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_watchers WHERE account_id=?').bind(session.account_id).all<any>()).results[0].n).toBe(1);
		} finally { mock.restore(); setPacingForTests({}); }
	});

	it('the alerts CSP admits exactly the shipped guard script, and the guard ships on widget surfaces', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const response = await alertsRoute(get('/alerts'), env);
		const csp = response?.headers.get('Content-Security-Policy') ?? '';
		expect(turnstileClientScriptHash).toBe(createHash('sha256').update(turnstileClientScript).digest('base64'));
		expect(csp).toContain(`'sha256-${turnstileClientScriptHash}'`);
		const html = await response?.text();
		expect(html).toContain('__prTsOk');
		expect(html).toContain('aria-live');
	});
});

async function alertNoStore(response: Response | undefined): Promise<boolean> {
	return response?.headers.get('Cache-Control') === 'no-store';
}

describe('prior-day pending signup regression', () => {
 it('queues confirmation after expiry with no previous outbox', async () => {
  const {DB,db}=database(), env=baseEnv(DB), now=Date.now();
  mockFetch(c=>c.url.includes('siteverify')?turnstileOk():Response.json({success:true}));
  await subscribe(env,{email:'regression@example.org',phrase:'luma',captcha:'valid'},now-2*86400000);
  db.exec('DELETE FROM alert_outbox');
  const html=await renderer.fetch(get('/signup?lang=en'),{items:[],translations:{},feeds:[],alerts:{available:true,siteKey:'0xSITEKEY'}}).text();
  const form=html.match(/<form class="signup-form"[\s\S]*?<\/form>/)![0];
  const fields: Record<string,string>={};
  for(const input of form.matchAll(/<input\b[^>]*>/g)) {
   const name=input[0].match(/name="([^"]+)"/)?.[1];
   if(name) fields[name]=input[0].match(/value="([^"]*)"/)?.[1]??'';
  }
  fields.email='regression@example.org'; fields.phrase='luma'; fields['cf-turnstile-response']='valid';
  const response=await alertsRoute(post(form.match(/action="([^"]+)"/)![1],fields),env);
  expect(response?.status).toBe(202);
  expect(db.prepare('SELECT count(*) AS n FROM alert_outbox').get()?.n).toBe(1);
 });
 it('rejects a browser-valid but unmatchable phrase instead of claiming acceptance', async () => {
  const {DB,db}=database();
  mockFetch(c=>c.url.includes('siteverify')?turnstileOk():Response.json({}));
  const response=await alertsRoute(post('/alerts/signup',captchaForm({email:'regression@example.org',phrase:'a'})),baseEnv(DB));
  expect(response?.status).toBe(400);
  expect(db.prepare("SELECT count FROM alert_limits WHERE bucket='signup-outcome:invalid-phrase'").get()?.count).toBe(1);
  expect(db.prepare('SELECT count(*) AS n FROM alert_accounts').get()?.n).toBe(0);
 });
});

 describe('natural alert phrases', () => {
 it.each(['Act60', 'Ley60', 'act 60', '  AcT   60  ', 'Puerto Rico', 'section936', '5G'])('accepts signup and edits for %s', async phrase => {
  const { DB, db } = database(); const env = baseEnv(DB);
  mockFetch(call => call.url.includes('siteverify') ? turnstileOk() : Response.json({}, {status: 429}));
  const response = await alertsRoute(post('/alerts/signup', captchaForm({email: 'phrase@example.org', phrase})), env);
  expect(response?.status).toBe(202);
  expect(db.prepare('SELECT tokens FROM alert_watchers').get()?.tokens).toBe(phraseTokens(phrase));
  expect(db.prepare('SELECT count(*) AS n FROM alert_outbox').get()?.n).toBe(1);
  db.prepare('UPDATE alert_tokens SET expires_at=0').run();
  db.prepare('UPDATE alert_outbox SET created_at=0').run();
  await subscribe(env, {email:'phrase@example.org', phrase, captcha:'valid'});
  expect(db.prepare('SELECT count(*) AS n FROM alert_outbox').get()?.n).toBe(2);
  const account = db.prepare('SELECT id FROM alert_accounts').get()!;
  const watcher = db.prepare('SELECT id FROM alert_watchers').get()!;
  expect(await manageWatcher(env, String(account.id), 'edit', String(watcher.id), phrase)).toBe('ok');
  expect(await manageWatcher(env, String(account.id), 'add', '', phrase)).toBe('ok');
 });
 it('matches every whole token in any order, without numeric prefixes or aliases', () => {
  for (const title of ['Act 60', '60: ACT', 'act-60']) expect(phraseMatches(phraseTokens(' act  60 '), {item:item('https://example.org', title, 1)})).toBe(true);
  for (const title of ['Act 600', 'Act 160', 'Ley 60', 'Act60']) expect(phraseMatches(phraseTokens('act 60'), {item:item('https://example.org', title, 1)})).toBe(false);
 });
 });

describe('hostile and Unicode phrase inputs', () => {
 const valid: [string, string][] = [
  [' act\t60\n', '60 act'], ['act\u00a060', '60 act'], ['act\u200b60', '60 act'],
  ['act\0 60', '60 act'], ['ACT ACT 60', '60 act'], ['🇵🇷 Act 60', '60 act'],
  ['“Puerto”—Rico', 'puerto rico'], ["Puerto’s Rico", 'puerto rico'],
  ['San Juan', 'juan san'], ['San Jua\u0301n', 'juán san'], ['60', '60'],
  ['ab', 'ab'], ['a'.repeat(48), 'a'.repeat(48)],
  ['<script>alert(60)</script>', '60 alert script'], ["act'; DROP TABLE alerts;--", 'act alerts drop table'],
  ['(act|60).*$', '60 act'], ['act '.repeat(30), 'act'],
 ];
 it.each(valid)('normalizes and safely enrolls %j', async (phrase, expected) => {
  expect(phraseTokens(phrase)).toBe(expected);
  const { DB, db } = database(); const env = baseEnv(DB);
  mockFetch(call => call.url.includes('siteverify') ? turnstileOk() : Response.json({}, {status:429}));
  expect((await alertsRoute(post('/alerts/signup', captchaForm({email:'test@example.org',phrase})),env))?.status).toBe(202);
  expect(db.prepare('SELECT tokens FROM alert_watchers').get()?.tokens).toBe(expected);
  expect(db.prepare('SELECT count(*) AS n FROM alert_outbox').get()?.n).toBe(1);
 });
 it.each(['', '  \t\n\u00a0', '🎉', '?!.*', 'a', '1', 'a'.repeat(49), 'act '.repeat(31)])('rejects %j without mail or destructive edit', async phrase => {
  const {DB, db} = database(); const env = baseEnv(DB);
  mockFetch(call => call.url.includes('siteverify') ? turnstileOk() : Response.json({}, {status:429}));
  expect((await alertsRoute(post('/alerts/signup', captchaForm({email:'test@example.org',phrase})),env))?.status).toBe(400);
  expect(db.prepare('SELECT count(*) AS n FROM alert_outbox').get()?.n).toBe(0);
  const a = await activated(env, {phrase:'act 60'});
  expect(await manageWatcher(env, a.session.account_id, 'edit', a.watcherId, phrase)).toBe('invalid');
  expect(db.prepare('SELECT tokens FROM alert_watchers').get()?.tokens).toBe('60 act');
 });
 it('normalizes equivalent Unicode in both article and alert', () => {
  expect(phraseMatches(phraseTokens('San Jua\u0301n'), {item:item('https://example.org', 'SAN JUÁN', 1)})).toBe(true);
  expect(phraseMatches(phraseTokens('San Juán'), {item:item('https://example.org', 'SAN JUA\u0301N', 1)})).toBe(true);
 });
 it('handles unknown types and bounded deterministic fuzz', () => {
  for (const value of [null, undefined, {}, [], 60, true]) expect(phraseTokens(value)).toBe('');
  let seed = 936;
  const chars = ['a', '6', ' ', '\0', '\u200b', 'é', '\u0301', '😀', '<', '"', '\n'];
  for (let n = 0; n < 150; n++) {
   let input = '';
   for (let j = 0; j < n; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; input += chars[seed % chars.length]; }
   const normalized = phraseTokens(input);
   expect(normalized.length).toBeLessThanOrEqual(120);
   expect(phraseTokens(normalized)).toBe(normalized);
  }
 });
 it('rejects missing fields, malformed and oversized bodies without queueing', async () => {
  const {DB, db} = database(); const env = baseEnv(DB);
  mockFetch(() => turnstileOk());
  for (const fields of [{}, {email:'test@example.org'}, {phrase:'Act 60'}, {email:'test@example.org',phrase:'x'.repeat(9000)}]) {
   expect((await alertsRoute(post('/alerts/signup', captchaForm(fields as Record<string, string>)),env))?.status).toBe(400);
  }
  const malformed = new Request('https://news.dev.pr/alerts/signup', {method:'POST',headers:{Origin:'https://news.dev.pr','Content-Type':'application/json'},body:'{"phrase":{}}'});
  expect((await alertsRoute(malformed,env))?.status).toBe(400);
  expect(db.prepare('SELECT count(*) AS n FROM alert_outbox').get()?.n).toBe(0);
 });
});

it('edits through HTTP, escapes displayed phrases, and prevents cross-account edits', async () => {
 const {DB, db} = database(); const env = baseEnv(DB);
 mockFetch(call => call.url.includes('siteverify') ? turnstileOk() : Response.json({}, {status:429}));
 const a = await activated(env, {phrase:'Act60'});
 const fields = {csrf:a.session.csrf!,action:'edit',id:a.watcherId,phrase:'  Act   60 '};
 const headers = {Cookie:`alerts_session=${a.session.secret}`};
 expect((await alertsRoute(post('/alerts/watcher',fields,headers),env))?.status).toBe(303);
 expect(db.prepare('SELECT tokens FROM alert_watchers WHERE id=?').get(a.watcherId)?.tokens).toBe('60 act');
 expect(await manageWatcher(env, 'other-account', 'edit', a.watcherId, 'different')).toBe('invalid');
 const malicious = '<script>alert(60)</script>"';
 await alertsRoute(post('/alerts/watcher',{...fields,phrase:malicious},headers),env);
 const page = await alertsRoute(get('/alerts',headers),env);
 const html = await page!.text();
 expect(html).toContain('&lt;script&gt;');
 expect(html).not.toContain(malicious);
});

/** Reproduce email-only My alerts with the production state: pending watcher,
 * expired confirmation, and no retained outbox. No provider traffic escapes the mocks. */
function seedPendingLogin(db: DatabaseSync, now: number, state = 'unconfirmed') {
 const created = now - 2 * 86400000;
 db.prepare('INSERT INTO alert_accounts(id,email,language,status,created_at) VALUES(?,?,?,?,?)').run('recover', 'recover@example.org', 'es', state, created);
 db.prepare('INSERT INTO alert_watchers(id,account_id,phrase,tokens,status,baseline,scan_cursor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('saved', 'recover', 'Act 60', '60 act', 'pending', created, created, created, created);
 db.prepare('INSERT INTO alert_tokens(id,account_id,purpose,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)').run('expired', 'recover', 'confirm', createHash('sha256').update('x'.repeat(64)).digest('hex'), now - 86400000, created);
}

describe('email-only recovery and edition persistence', () => {
 it.each(['es','en'] as const)('follows %s homepage → My alerts → email only → confirmation → saved management', async lang => {
  const {DB,db} = database(); const env = baseEnv(DB); seedPendingLogin(db, Date.now());
  const before = db.prepare('SELECT * FROM alert_watchers').get();
  const mock = mockFetch(c => c.url.includes('siteverify') ? turnstileOk('signin') : Response.json({id:'recovered'}));
  const home = await renderer.fetch(get('/?lang='+lang), {items:[],translations:{},feeds:[]}).text();
  const link = home.match(new RegExp('href="([^" ]+)">'+(lang==='en'?'My alerts':'Mis alertas')+'</a>'))![1].replaceAll('&amp;','&');
  expect(new URL(link,'https://news.dev.pr').searchParams.get('lang') ?? 'es').toBe(lang);
  const page = await (await alertsRoute(get(link),env))!.text();
  expect(page).toContain(`<html lang="${lang}">`);
  expect(page).not.toContain('name="phrase"');
  const action = page.match(/<form method="post" action="([^"]+)"/)![1];
  expect(action).toBe('/alerts/signin?lang='+lang);
  expect(page).toContain(`name="lang" value="${lang}"`);
  const fields = captchaForm({email:'recover@example.org',lang,x_presencia:'autofill'});
  const response = await alertsRoute(post(action,fields),env);
  expect(response?.status).toBe(202);
  const body = await response!.text();
  expect(body).toContain(`<html lang="${lang}">`);
  expect(body).toContain(`href="https://news.dev.pr/?lang=${lang}">${lang==='en'?'Back':'Volver'}</a>`);
  expect(body).toContain(lang==='en'?'If you previously created an alert':'Si ya creaste una alerta');
  expect(body).not.toContain(lang==='en'?'Si ya creaste una alerta':'If you previously created an alert');
  expect(db.prepare('SELECT * FROM alert_watchers').get()).toEqual(before);
  expect(db.prepare('SELECT status FROM alert_accounts').get()?.status).toBe('unconfirmed');
  const row = db.prepare('SELECT kind,state,payload FROM alert_outbox').get()!;
  expect(row.kind).toBe('confirm'); expect(row.state).toBe('sent');
  expect(db.prepare('SELECT count(*) AS n FROM alert_sessions').get()?.n).toBe(0);
  // Repeat before redemption preserves token and avoids duplicate confirmation mail.
  await alertsRoute(post(action,fields),env);
  expect(db.prepare('SELECT count(*) AS n FROM alert_outbox').get()?.n).toBe(1);
  const sends = mock.calls.filter(c=>c.url.includes('/emails/outbound'));
  expect(sends).toHaveLength(1);
  const mail = String(sends[0].json.text);
  const confirmation = mail.match(/https:\/\/news\.dev\.pr\/alerts\/confirm\?\S+/)![0];
  expect(new URL(confirmation).searchParams.get('lang')).toBe(lang);
  const token = JSON.parse(String(row.payload)).token;
  expect(db.prepare('SELECT token_hash FROM alert_tokens WHERE expires_at>?').get(Date.now())?.token_hash).not.toBe(token);
  const confirmed = await alertsRoute(new Request(confirmation),env);
  expect(confirmed?.status).toBe(303);
  expect(confirmed?.headers.get('Location')).toBe('/alerts?lang='+lang);
  const cookie = confirmed!.headers.get('Set-Cookie')!.split(';')[0];
  const managed = await (await alertsRoute(get(confirmed!.headers.get('Location')!,{Cookie:cookie}),env))!.text();
  expect(managed).toContain(`<html lang="${lang}">`);
  for (const label of (lang==='en'?['Act 60','Create alert','Save','Pause','Delete']:['Act 60','Crear alerta','Guardar','Pausar','Eliminar'])) expect(managed).toContain(label);
  expect(db.prepare('SELECT status FROM alert_watchers').get()?.status).toBe('active');
  expect((await alertsRoute(new Request(confirmation),env))?.headers.get('Set-Cookie')).toBeNull();
 });

 it('returns identical non-enumerating responses for unknown, closed, active and unconfirmed accounts', async () => {
  const bodies:string[]=[];
  for(const status of ['unknown','closed','active','unconfirmed']) {
   const {DB,db}=database(); const env=baseEnv(DB);
   if(status!=='unknown') seedPendingLogin(db,Date.now(),status);
   mockFetch(c=>c.url.includes('siteverify')?turnstileOk('signin'):Response.json({id:'ok'}));
   const response=await alertsRoute(post('/alerts/signin?lang=en',captchaForm({email:'recover@example.org'})),env);
   expect(response?.status).toBe(202); bodies.push(await response!.text());
   expect(db.prepare('SELECT count(*) AS n FROM alert_accounts').get()?.n).toBe(status==='unknown'?0:1);
   const mail=db.prepare('SELECT kind FROM alert_outbox').get();
   expect(mail?.kind).toBe(status==='active'?'signin':status==='unconfirmed'?'confirm':undefined);
   if(status!=='unknown') expect(db.prepare('SELECT status FROM alert_accounts').get()?.status).toBe(status);
   vi.restoreAllMocks();
  }
  expect(new Set(bodies).size).toBe(1);
 });

 it.each(['pending','sent','uncertain'] as const)('reuses a valid confirmation with %s delivery, without minting another', async state=>{
  const {DB,db}=database(); const env=baseEnv(DB); seedPendingLogin(db,Date.now());
  mockFetch(c=>c.url.includes('siteverify')?turnstileOk('signin'):Response.json({id:'ok'}));
  await requestSignin(env,{email:'recover@example.org',captcha:'valid'});
  db.prepare('UPDATE alert_outbox SET state=?,lease_until=0').run(state);
  const token=db.prepare('SELECT token_hash FROM alert_tokens WHERE expires_at>?').get(Date.now());
  vi.restoreAllMocks();
  const mock=mockFetch(c=>c.url.includes('siteverify')?turnstileOk('signin'):Response.json({id:'retry-ok'}));
  await requestSignin(env,{email:'recover@example.org',captcha:'valid'},Date.now()+1000);
  expect(db.prepare('SELECT count(*) AS n FROM alert_outbox').get()?.n).toBe(1);
  expect(db.prepare('SELECT token_hash FROM alert_tokens WHERE expires_at>?').get(Date.now())).toEqual(token);
  expect(mock.calls.filter(c=>c.url.includes('/emails/outbound'))).toHaveLength(state==='pending'?1:0);
 });

 it('keeps the shared three-confirmation daily limit on the recovery path', async()=>{
  const {DB,db}=database(); const env=baseEnv(DB); seedPendingLogin(db,Date.now());
  const mock=mockFetch(c=>c.url.includes('siteverify')?turnstileOk('signin'):Response.json({id:'ok'}));
  for(let i=0;i<4;i++) {
   db.prepare('UPDATE alert_tokens SET expires_at=0').run();
   await requestSignin(env,{email:'recover@example.org',captcha:'valid'},Date.now()+i*1000);
  }
  expect(db.prepare('SELECT count(*) AS n FROM alert_outbox').get()?.n).toBe(3);
  expect(mock.calls.filter(c=>c.url.includes('/emails/outbound'))).toHaveLength(3);
 });

 it.each(['es','en'] as const)('renders retry, validation, blocked origin and expired link in %s only',async lang=>{
  const {DB,db}=database(); const env=baseEnv(DB);
  mockFetch(c=>c.url.includes('siteverify')?turnstileOk('signin'):Response.json({id:'ok'}));
  const cases:[Request,number,string,string][]=[
   [post('/alerts/signin?lang='+lang,{email:'bad@example.org'}),400,'No pudimos verificar','We could not verify'],
   [post('/alerts/signin?lang='+lang,captchaForm({email:'not-an-email'})),400,'Ingresa un correo válido','Enter a valid email'],
   [post('/alerts/signin?lang='+lang,captchaForm({email:'bad@example.org'}),{Origin:'https://foreign.example'}),403,'El envío se detuvo','Your submission stopped'],
   [get('/alerts/confirm?lang='+lang),200,'Este enlace no abrió','This link did not open'],
   [get('/alerts/in?lang='+lang),200,'Enlace no válido','Link invalid'],
  ];
  for(const [request,status,es,en] of cases) {
   const response=await alertsRoute(request,env);expect(response?.status).toBe(status);
   const html=await response!.text();expect(html).toContain(`<html lang="${lang}">`);
   expect(html).toContain(lang==='en'?en:es);expect(html).not.toContain(lang==='en'?es:en);
   expect(html).toContain(`href="https://news.dev.pr/?lang=${lang}"`);
  }
  expect(db.prepare('SELECT count(*) AS n FROM alert_outbox').get()?.n).toBe(0);
 });

 it('uses hidden form language when no query language exists, without echoing hostile input',async()=>{
  const {DB}=database(); const env=baseEnv(DB);
  mockFetch(c=>c.url.includes('siteverify')?turnstileOk('signin'):Response.json({id:'ok'}));
  const response=await alertsRoute(post('/alerts/signin',captchaForm({email:"'OR'1'='1';--@example.org",lang:'en'})),env);
  const html=await response!.text();expect(response?.status).toBe(202);
  expect(html).toContain('<html lang="en">');expect(html).not.toContain('OR 1=1');
  const invalid=await alertsRoute(post('/alerts/signin',captchaForm({email:'test@example.org',lang:'<script>'})),env);
  expect(await invalid!.text()).toContain('<html lang="es">');
 });

 it('does not bypass Turnstile when the email-only honeypot is filled',async()=>{
  const {DB,db}=database();const env=baseEnv(DB);seedPendingLogin(db,Date.now());
  const mock=mockFetch(()=>Response.json({success:false}));
  const response=await alertsRoute(post('/alerts/signin',captchaForm({email:'recover@example.org',x_presencia:'bot'})),env);
  expect(response?.status).toBe(202);
  expect(db.prepare('SELECT count(*) AS n FROM alert_outbox').get()?.n).toBe(0);
  expect(mock.calls.filter(c=>c.url.includes('siteverify'))).toHaveLength(1);
  expect(mock.calls.filter(c=>c.url.includes('/emails/outbound'))).toHaveLength(0);
 });
});

describe('clear add versus edit controls', () => {
 it.each(['es', 'en'] as const)('keeps existing %s alerts read-only until Edit, and Cancel leaves them unchanged', async lang => {
  const { DB, db } = database(); const env = baseEnv(DB);
  mockFetch(c => c.url.includes('siteverify') ? turnstileOk() : Response.json({ id: 'test-only' }));
  const { session, watcherId } = await activated(env, { phrase: 'Act 60', language: lang });
  const headers = { Cookie: `alerts_session=${session.secret}` };
  const before = db.prepare('SELECT * FROM alert_watchers WHERE id=?').get(watcherId);
  const response = await alertsRoute(get(`/alerts?lang=${lang}`, headers), env);
  const html = await response!.text();
  expect(response?.headers.get('Cache-Control')).toBe('no-store');
  expect(html).toContain(lang === 'en' ? 'Add a new alert' : 'Añadir una alerta nueva');
  expect(html.match(/class="add-alert"/g)).toHaveLength(1);
  const row = html.match(/<section class="watcher">([\s\S]*?)<\/section>/)![1];
  expect(row).toContain('<strong>Act 60</strong>');
  expect(row).toContain(`<details class="watcher-edit"><summary>${lang === 'en' ? 'Edit' : 'Editar'}</summary>`);
  expect(row).not.toMatch(/<details[^>]*\bopen\b/);
  const detail = row.match(/<details[^>]*>([\s\S]*?)<\/details>/)![1];
  expect(detail).toContain(lang === 'en' ? 'Edit phrase' : 'Editar frase');
  expect(detail).toContain(lang === 'en' ? 'Save changes' : 'Guardar cambios');
  expect(row.replace(/<details[\s\S]*?<\/details>/, '')).not.toContain('name="phrase"');
  // Edit and quick actions have separate, unnested forms and distinct action fields.
  const forms = [...row.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map(m => m[0]);
  expect(forms).toHaveLength(2);
  for (const form of forms) {
   expect(form.match(/<form\b/g)).toHaveLength(1);
   expect(form).toContain(`action="/alerts/watcher?lang=${lang}"`);
   expect(form).toContain(`name="csrf" value="${session.csrf}"`);
   expect(form).toContain(`name="id" value="${watcherId}"`);
  }
  expect(forms[0]).toContain('name="action" value="edit"');
  expect(forms[1]).not.toContain('value="edit"');
  expect(forms[1]).toContain('name="action" value="pause"');
  expect(forms[1]).toContain('name="action" value="delete"');
  const cancel = detail.match(/href="([^"]+)">(?:Cancel|Cancelar)<\/a>/)![1];
  expect(cancel).toBe(`/alerts?lang=${lang}`);
  await alertsRoute(get(cancel, headers), env);
  expect(db.prepare('SELECT * FROM alert_watchers WHERE id=?').get(watcherId)).toEqual(before);
  // Save is the sole edit mutation; quick actions still work without a phrase input.
  const saved = await alertsRoute(post(`/alerts/watcher?lang=${lang}`, { csrf: session.csrf, id: watcherId, action: 'edit', phrase: 'Act 60 taxes' }, headers), env);
  expect(saved?.status).toBe(303);
  expect(saved?.headers.get('Location')).toBe(`/alerts?lang=${lang}`);
  expect(db.prepare('SELECT phrase FROM alert_watchers WHERE id=?').get(watcherId)?.phrase).toBe('Act 60 taxes');
  await alertsRoute(post(`/alerts/watcher?lang=${lang}`, { csrf: session.csrf, id: watcherId, action: 'pause' }, headers), env);
  const paused = await (await alertsRoute(get(`/alerts?lang=${lang}`, headers), env))!.text();
  expect(paused).toContain('name="action" value="resume"');
  expect(paused).toContain(lang === 'en' ? '· paused' : '· pausada');
 });
});

describe('signed-in alert account identity', () => {
 it.each(['es', 'en'] as const)('shows the session account only in authenticated %s management', async lang => {
  const { DB, db } = database(); const env = baseEnv(DB);
  mockFetch(c => c.url.includes('siteverify') ? turnstileOk() : Response.json({ id: 'test-only' }));
  const { session } = await activated(env, { email: 'owner@example.org', phrase: 'Act 60' });
  const headers = { Cookie: `alerts_session=${session.secret}` };
  // A hostile query parameter cannot select or impersonate the account being displayed.
  const path = `/alerts?lang=${lang}&email=other@example.org`;
  const response = await alertsRoute(get(path, headers), env);
  const html = await response!.text();
  expect(response!.headers.get('Cache-Control')).toBe('no-store');
  expect(html).toContain(`<p class="signed-in">${lang === 'en' ? 'Signed in as' : 'Sesión iniciada como'} <strong>owner@example.org</strong></p>`);
  expect(html).not.toContain('other@example.org');
  expect(html).not.toMatch(/(?:href|action)="[^"]*owner@example/);
  expect(html).not.toContain('beacon.min.js');
  expect(html).toContain('.signed-in{overflow-wrap:anywhere}');
  expect(html).toContain('class="add-alert"');
  for (const cookie of ['', `alerts_session=invalid-secret`, `alerts_session=${session.secret}`]) {
   if (cookie === `alerts_session=${session.secret}`) db.prepare('UPDATE alert_sessions SET expires_at=0').run();
   const loggedOut = await alertsRoute(get(path, cookie ? { Cookie: cookie } : {}), env);
   const publicHtml = await loggedOut!.text();
   expect(loggedOut!.headers.get('Cache-Control')).toBe('no-store');
   expect(publicHtml).toContain(`action="/alerts/signin?lang=${lang}"`);
   expect(publicHtml).toContain(lang === 'en' ? 'Email me a link' : 'Enviarme un enlace');
   expect(publicHtml).not.toContain('<p class="signed-in">');
   expect(publicHtml).not.toContain('owner@example.org');
   expect(publicHtml).not.toContain('other@example.org');
   expect(publicHtml).not.toContain('class="add-alert"');
   expect(publicHtml).not.toContain('class="watcher"');
  }
 });
 it('escapes stored account email as text', async () => {
  const { DB, db } = database(); const env = baseEnv(DB);
  mockFetch(c => c.url.includes('siteverify') ? turnstileOk() : Response.json({ id: 'test-only' }));
  const { session } = await activated(env);
  // Defense in depth even if imported/corrupt data bypassed signup email validation.
  db.prepare('UPDATE alert_accounts SET email=? WHERE id=?').run('<img src=x onerror="alert(1)">&\'@example.org', session.account_id);
  const html = await (await alertsRoute(get('/alerts?lang=en', { Cookie: `alerts_session=${session.secret}` }), env))!.text();
  expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;@example.org');
  expect(html).not.toContain('<img src=x');
 });
});

describe('alerts home navigation', () => {
 it.each(['es', 'en'] as const)('renders the editorial masthead across %s alert surfaces', async lang => {
  const { DB } = database(); const env = baseEnv(DB);
  mockFetch(c => c.url.includes('siteverify') ? turnstileOk() : Response.json({ id: 'test-only' }));
  const { session } = await activated(env);
  const responses = [
   await alertsRoute(get(`/alerts?lang=${lang}`), env),
   await alertsRoute(get(`/alerts?lang=${lang}`, { Cookie: `alerts_session=${session.secret}` }), env),
   await alertsRoute(get(`/alerts/confirm?token=invalid&lang=${lang}`), env),
   await alertsRoute(post(`/alerts/signin?lang=${lang}`, { email: 'fixture@example.org' }, { Origin: 'https://other.example' }), env),
  ];
  for (const response of responses) {
   expect(response).toBeTruthy();
   expect(response!.headers.get('Cache-Control')).toBe('no-store');
   expect(response!.headers.get('Referrer-Policy')).toBe('no-referrer');
   const csp = response!.headers.get('Content-Security-Policy') ?? '';
   expect(csp).toContain("default-src 'none'");
   expect(csp).toContain(`'sha256-${alertThemeBootHash}'`);
   expect(csp).toContain(`'sha256-${alertThemeToggleHash}'`);
   expect(csp).toContain("font-src 'self'");
   const html = await response!.text();
   expect(html).toContain('<header class="wrap masthead">');
   expect(html).toContain(`<a class="brand" href="/?lang=${lang}">news<b>.dev.pr</b></a>`);
   expect(html).toContain(lang === 'en' ? 'Puerto Rico News' : 'Noticias de Puerto Rico');
   expect(html).toContain('class="languages"');
   expect(html).toContain('id="theme"');
   expect(html).toContain('<main id="contenido" class="wrap"><div class="alerts-page">');
   expect(html).toContain('<footer>');
   expect(html).toContain(`href="https://news.dev.pr/?lang=${lang}"`);
   expect(html).not.toMatch(/beacon\.min\.js|cloudflareinsights|\/api\/live|data-lighter-url|\/api\/lighter|data-cf-beacon/);
   expect(html).not.toContain(session.secret);
   expect(html.match(/© /g)).toHaveLength(1);
   expect(html).toContain('Adam Beguelin');
  }
 });
 it.each(['es', 'en'] as const)('keeps guest and signed-in %s pages in the front-page measure at phone and desk widths', async lang => {
  const { DB } = database(); const env = baseEnv(DB);
  mockFetch(c => c.url.includes('siteverify') ? turnstileOk() : Response.json({ id: 'test-only' }));
  const { session } = await activated(env, { email: 'owner@example.org', phrase: 'Act 60' });
  const guest = await (await alertsRoute(get(`/alerts?lang=${lang}`), env))!.text();
  const signed = await (await alertsRoute(get(`/alerts?lang=${lang}`, { Cookie: `alerts_session=${session.secret}` }), env))!.text();
  expect(alertThemeBootHash).toBe(createHash('sha256').update(alertThemeBoot).digest('base64'));
  expect(alertThemeToggleHash).toBe(createHash('sha256').update(alertThemeToggle).digest('base64'));
  for (const html of [guest, signed]) {
   expect(html).toContain('width=device-width');
   expect(html).toContain('@media(max-width:390px)');
   expect(html).toContain('@media(max-width:480px)');
   expect(html).toContain('@media(min-width:900px)');
   expect(html).toContain('.wrap{max-width:1240px');
   expect(html).not.toContain('max-width:520px');
   expect(html).toContain(`<script>${alertThemeBoot}</script>`);
   expect(html).toContain(`<script>${alertThemeToggle}</script>`);
   expect(html).not.toContain('beacon.min.js');
   expect(html).not.toContain('data-lighter-url');
   expect(html).not.toContain('/api/lighter');
  }
  expect(guest).toContain(lang === 'en' ? 'Email me a link' : 'Enviarme un enlace');
  expect(guest).not.toContain('<p class="signed-in">');
  expect(guest).not.toContain('owner@example.org');
  expect(signed).toContain(`<p class="signed-in">${lang === 'en' ? 'Signed in as' : 'Sesión iniciada como'} <strong>owner@example.org</strong></p>`);
  expect(signed).toContain('class="add-alert"');
  expect(signed).toContain('class="account-actions"');
  expect(signed).not.toContain(session.secret);
 });
});

describe('notification edition', () => {
 for (const language of ['es', 'en'] as const) it(language + ' preserves a coherent batch and defers missing English', async () => {
  const { DB } = database(); const env = baseEnv(DB);
  const mock = mockFetch(call => call.url.includes('siteverify') ? turnstileOk() : Response.json({id:'ok'}));
  const {now, session} = await activated(env, {language});
  expect((await DB.prepare('SELECT language FROM alert_accounts').first<any>()).language).toBe(language);
  const story = {...item('https://example.org/edition', 'LUMA repara el servicio', now+1000, 'La reparación continúa.'), source:'endi'};
  await insertArticle(env, story, now+1000, language === 'es' ? {originalTitle:story.title,originalSummary:story.summary,title:'LUMA repairs service',summary:'Repairs continue.'} : undefined);
  await runAlertSweep(env, now+2000);
  if(language === 'en') expect(await getOutbox(env,'notify').first()).toBeNull();
  await DB.prepare('UPDATE articles SET translation=?').bind(JSON.stringify({originalTitle:story.title,originalSummary:story.summary,title:'LUMA repairs service',summary:'Repairs continue.'})).run();
  await runAlertSweep(env, now+4000);
  const row = await getOutbox(env,'notify').first<any>();
  const payload = JSON.parse(row.payload);
  expect(payload.items[0].title).toBe(language==='en'?'LUMA repairs service':story.title);
  const mail = mock.calls.find(c => String(c.json.subject).startsWith(language==='en'?'Keyword alert:':'Alerta:'))!.json;
  for (const body of [mail.html,mail.text]) {
   expect(body).toContain(language==='en'?'LUMA repairs service':story.title);
   expect(body).toContain(language==='en'?'Matches for your keyword alerts':'Coincidencias con tus alertas');
   expect(body).toContain('lang='+language);
   expect(body).toContain('El Nuevo Día');
  }
  const nextLanguage = language==='en'?'es':'en';
  const response = await alertsRoute(post('/alerts/watcher?lang='+nextLanguage, {action:'add',phrase:'budget',csrf:session.csrf}, {Cookie:'alerts_session='+session.secret}), env);
  expect(response!.status).toBe(303);
  expect((await DB.prepare('SELECT language FROM alert_accounts').first<any>()).language).toBe(language==='en'?'es':'en');
  mock.restore();
 });
});

describe('first confirmation operator notice', () => {
 const ownerRows = (env: AlertEnv) => env.DB.prepare("SELECT id,email,payload,state,kind FROM alert_outbox WHERE kind='owner'").bind().all<{ id: string; email: string; payload: string; state: string; kind: string }>();
 const notices = (env: AlertEnv) => env.DB.prepare('SELECT account_id,outbox_id,confirmed_at FROM alert_signup_notices').bind().all<{ account_id: string; outbox_id: string; confirmed_at: number }>();

 it('enqueues one paced notice on the first confirmation and ignores replay, sign-in, and watcher edits', async () => {
  const { DB, db } = database(); const env = baseEnv(DB);
  const sends: FetchCall[] = [];
  let verifyCalls = 0;
  const mock = mockFetch(call => {
   if (call.url.includes('siteverify')) return turnstileOk(++verifyCalls === 1 ? 'signup' : 'signin');
   if (call.url.includes('/emails/outbound')) { sends.push(call); return Response.json({ id: 'owner-1' }); }
   return Response.json({ logs: [] });
  });
  try {
   setPacingForTests({ minIntervalMs: 1, minuteCap: 100, dailyCap: 100000 });
   // Wall clock, same as the other paced sends: a historical `now` sits behind
   // alert_pace.last_send (stamped with Date.now()) and the gate sleeps 120s.
   const now = Date.now();
   await subscribe(env, { email: 'reader@example.org', phrase: 'Tom & Jerry <script> "x"', captcha: 'valid' }, now);
   expect((await ownerRows(env)).results).toHaveLength(0);
   const token = JSON.parse((await getOutbox(env, 'confirm').first<any>()).payload).token;
   db.prepare("INSERT INTO alert_watchers(id,account_id,phrase,tokens,status,baseline,scan_cursor,created_at,updated_at) SELECT 'second', id, ?, 'luma', 'pending', ?, ?, ?, ? FROM alert_accounts").run('luma', now, now, now + 1, now + 1);
   const result = await confirm(env, token, now + 60_000);
   expect(result.status).toBe('confirmed');
   const rows = (await ownerRows(env)).results;
   expect(rows).toHaveLength(1);
   expect(rows[0].state).toBe('sent');
   expect(rows[0].email).toBe(OWNER_SIGNUP_EMAIL);
   expect(rows[0].id).toBe('owner-signup:' + (await notices(env)).results[0].account_id);
   const payload = JSON.parse(rows[0].payload);
   expect(payload.phrases).toEqual(['Tom & Jerry <script> "x"', 'luma']);
   expect(JSON.stringify(payload)).not.toContain('reader@example.org');
   const ownerMail = sends.filter(isOwnerSend);
   expect(ownerMail).toHaveLength(1);
   expect(ownerMail[0].url).toBe('https://api.improvmx.com/v4/domains/code.pr/emails/outbound');
   expect(ownerMail[0].json.from).toBe('prnews');
   expect(ownerMail[0].json.reply_to).toBe('prnews@code.pr');
   expect(ownerMail[0].json.to).toBe(OWNER_SIGNUP_EMAIL);
   expect(ownerMail[0].json.subject).not.toContain('reader@example.org');
   expect(ownerMail[0].json.subject).not.toContain('<script>');
   expect(ownerMail[0].json.html).toContain('&amp;');
   expect(ownerMail[0].json.html).toContain('&lt;script&gt;');
   expect(ownerMail[0].json.html).toContain('luma');
   expect(ownerMail[0].json.html).not.toContain('<script>');
   expect(ownerMail[0].json.html).not.toContain('reader@example.org');
   expect(ownerMail[0].json.text).not.toContain('reader@example.org');
   expect(ownerMail[0].json.text).toContain('Tom & Jerry <script> "x"');
   expect(String(ownerMail[0].json.text)).toContain('AST');
   expect(await env.DB.prepare('SELECT id FROM alert_queue').bind().first()).toBeNull();
   expect(await getOutbox(env, 'notify').first()).toBeNull();

   expect((await confirm(env, token, now + 61_000)).status).toBe('processed');
   await requestSignin(env, { email: 'reader@example.org', captcha: 'valid' }, now + 62_000);
   expect(await getOutbox(env, 'signin').first()).not.toBeNull();
   const session = await sessionFromCookie(env, result.status === 'confirmed' ? result.session.secret : '', now + 60_000);
   await manageWatcher(env, session!.account_id, 'edit', (await env.DB.prepare("SELECT id FROM alert_watchers WHERE phrase='luma'").bind().first<{ id: string }>())!.id, 'otra frase', now + 63_000);
   await manageWatcher(env, session!.account_id, 'add', '', 'presupuesto', now + 64_000);
   expect((await ownerRows(env)).results).toHaveLength(1);
   expect(JSON.parse((await ownerRows(env)).results[0].payload).phrases).toEqual(['Tom & Jerry <script> "x"', 'luma']);
   expect(sends.filter(isOwnerSend)).toHaveLength(1);

   await insertArticle(env, item('https://match.example/1', 'Llega el presupuesto', now + 70_000), now + 70_000);
   await runAlertSweep(env, now + 80_000);
   expect((await ownerRows(env)).results).toHaveLength(1);
   const notify = await getOutbox(env, 'notify').first<any>();
   expect(notify.email).toBe('reader@example.org');
   expect(sends.filter(isOwnerSend)).toHaveLength(1);
  } finally { mock.restore(); setPacingForTests({}); }
 });

 it('keeps the same notice across unsubscribe, a closed reconfirmation, and an outbox prune', async () => {
  const { DB, db } = database(); const env = baseEnv(DB);
  const mock = mockFetch(call => call.url.includes('siteverify') ? turnstileOk('signup') : Response.json({ id: 'ok' }));
  try {
   setPacingForTests({ minIntervalMs: 1, minuteCap: 100, dailyCap: 100000 });
   const now = Date.now();
   const { session } = await activated(env, { email: 'again@example.org', phrase: 'luma', now });
   expect((await ownerRows(env)).results).toHaveLength(1);
   await env.DB.prepare("UPDATE alert_outbox SET state='pending', attempts=0, lease_until=0, sent_at=NULL WHERE kind='owner'").bind().run();
   await closeAccount(env, session.account_id);
   expect((await env.DB.prepare("SELECT state FROM alert_outbox WHERE kind='owner'").bind().first<any>()).state).toBe('pending');
   expect((await env.DB.prepare("SELECT status FROM alert_accounts").bind().first<any>()).status).toBe('closed');
   await runAlertSweep(env, now + 120_000);
   expect((await env.DB.prepare("SELECT state FROM alert_outbox WHERE kind='owner'").bind().first<any>()).state).toBe('sent');
   db.prepare("DELETE FROM alert_outbox WHERE kind='owner'").run();
   await subscribe(env, { email: 'again@example.org', phrase: 'nueva', captcha: 'valid' }, now + 130_000);
   const token = JSON.parse((await getOutbox(env, 'confirm').first<any>()).payload).token;
   expect((await confirm(env, token, now + 140_000)).status).toBe('confirmed');
   expect((await ownerRows(env)).results).toHaveLength(0);
   expect((await notices(env)).results).toHaveLength(1);
  } finally { mock.restore(); setPacingForTests({}); }
 });

 it('resolves an uncertain operator notice through the provider log and does not send a second copy when the log shows acceptance', async () => {
  const { DB } = database(); const env = baseEnv(DB);
  let ownerSends = 0;
  const mock = mockFetch(call => {
   if (call.url.includes('siteverify')) return turnstileOk();
   if (call.url.includes('/emails/outbound')) {
    if (isOwnerSend(call)) { ownerSends++; if (ownerSends === 1) throw new TypeError('network down'); return Response.json({ id: 'owner-retry' }); }
    return Response.json({ id: 'other' });
   }
   if (call.url.includes('/logs/search')) return Response.json({ logs: [] });
   if (call.url.includes('/logs')) return Response.json({ logs: [] });
   return Response.json({});
  });
  try {
   setPacingForTests({ minIntervalMs: 1, minuteCap: 100, dailyCap: 100000 });
   const now = Date.now();
   await activated(env, { email: 'uncertain@example.org', phrase: 'luma', now });
   expect((await env.DB.prepare("SELECT state,attempts FROM alert_outbox WHERE kind='owner'").bind().first<any>())).toMatchObject({ state: 'uncertain', attempts: 1 });
   await env.DB.prepare("UPDATE alert_outbox SET attempt_at=? WHERE kind='owner'").bind(now + 60_000 - 121_000).run();
   await runAlertSweep(env, now + 200_000);
   expect((await env.DB.prepare("SELECT state FROM alert_outbox WHERE kind='owner'").bind().first<any>()).state).toBe('pending');
   await runAlertSweep(env, now + 200_000 + 301_000);
   expect(ownerSends).toBe(2);
   expect((await env.DB.prepare("SELECT state FROM alert_outbox WHERE kind='owner'").bind().first<any>()).state).toBe('sent');
   await runAlertSweep(env, now + 900_000);
   expect(ownerSends).toBe(2);
  } finally { mock.restore(); setPacingForTests({}); }
 });

 it('does not resend an operator notice when the provider log already shows it', async () => {
  const { DB } = database(); const env = baseEnv(DB);
  let ownerSends = 0;
  const mock = mockFetch(call => {
   if (call.url.includes('siteverify')) return turnstileOk();
   if (call.url.includes('/emails/outbound') && isOwnerSend(call)) { ownerSends++; throw new TypeError('cut'); }
   if (call.url.includes('/emails/outbound')) return Response.json({ id: 'c1' });
   if (call.url.includes('/logs/search')) return Response.json({ logs: [{ id: 'seen' }] });
   return Response.json({ logs: [] });
  });
  try {
   setPacingForTests({ minIntervalMs: 1, minuteCap: 100, dailyCap: 100000 });
   const now = Date.now();
   await activated(env, { now });
   await env.DB.prepare("UPDATE alert_outbox SET attempt_at=? WHERE kind='owner'").bind(now - 121_000).run();
   await runAlertSweep(env, now + 200_000);
   expect((await env.DB.prepare("SELECT state FROM alert_outbox WHERE kind='owner'").bind().first<any>()).state).toBe('sent');
   expect(ownerSends).toBe(1);
  } finally { mock.restore(); setPacingForTests({}); }
 });

 it('still confirms the account when the operator notice cannot be recorded', async () => {
  const { DB } = database(); const env = baseEnv(DB);
  const wrapped = { ...env, DB: { prepare(sql: string) {
   if (sql.includes('alert_signup_notices')) return { bind: () => ({ run: async () => { throw new Error('notice down'); }, first: async () => { throw new Error('notice down'); }, all: async () => { throw new Error('notice down'); } }) };
   return env.DB.prepare(sql);
  } } as unknown as D1Database };
  const mock = mockFetch(call => call.url.includes('siteverify') ? turnstileOk() : Response.json({ id: 'ok' }));
  try {
   const now = 1_700_000_400_000;
   await subscribe(env, { email: 'still@example.org', phrase: 'luma', captcha: 'valid' }, now);
   const token = JSON.parse((await getOutbox(env, 'confirm').first<any>()).payload).token;
   const result = await confirm(wrapped, token, now + 1000);
   expect(result.status).toBe('confirmed');
   expect((await env.DB.prepare("SELECT status FROM alert_accounts WHERE email='still@example.org'").bind().first<any>()).status).toBe('active');
   expect((await ownerRows(env)).results).toHaveLength(0);
   expect((await notices(env)).results).toHaveLength(0);
  } finally { mock.restore(); }
 });

 it('keeps the outbox copy when the owner-kind migration is applied twice', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('migrations/0001_live.sql', 'utf8'));
  db.exec(readFileSync('migrations/0009_alerts.sql', 'utf8'));
  db.prepare("INSERT INTO alert_accounts(id,email,language,status,created_at) VALUES('acct','kept@example.org','es','active',1)").run();
  db.prepare("INSERT INTO alert_outbox(id,kind,account_id,email,payload,state,created_at) VALUES('row','notify','acct','kept@example.org','{}','sent',1)").run();
  const sql = readFileSync('migrations/0013_owner_signup_notice.sql', 'utf8');
  db.exec(sql);
  db.exec(sql);
  const row = db.prepare('SELECT kind,state,email FROM alert_outbox WHERE id=?').get('row') as { kind: string; state: string; email: string };
  expect(row).toEqual({ kind: 'notify', state: 'sent', email: 'kept@example.org' });
  expect(db.prepare("SELECT COUNT(*) AS n FROM alert_accounts").get()).toMatchObject({ n: 1 });
 });
});

describe('confirmed alert account counts', () => {
 it('counts active and closed accounts and renders no addresses or keywords', async () => {
  const { DB, db } = database(); const env = baseEnv(DB);
  expect(await confirmedAlertAccountCounts(env)).toEqual({ active: 0, closed: 0 });
  const empty = await renderer.fetch(new Request('https://news.dev.pr/stats?lang=en'), { items: [], translations: {}, feeds: [], alertAccounts: { active: 0, closed: 0 } }).text();
  expect(empty).toContain('id="alert-accounts"');
  expect(empty).toContain('0 active confirmed alert accounts');
  expect(empty).toContain('Closed accounts: 0');
  expect(empty).toContain('not people');
  db.prepare("INSERT INTO alert_accounts(id,email,language,status,created_at) VALUES('a','one@example.org','es','active',1),('b','two@example.org','en','active',2),('c','old@example.org','es','closed',3),('d','pending@example.org','es','unconfirmed',4)").run();
  db.prepare("INSERT INTO alert_watchers(id,account_id,phrase,tokens,status,baseline,scan_cursor,created_at,updated_at) VALUES('w','a','secreto','secreto','active',1,1,1,1)").run();
  expect(await confirmedAlertAccountCounts(env)).toEqual({ active: 2, closed: 1 });
  const counts = await confirmedAlertAccountCounts(env);
  const html = await renderer.fetch(new Request('https://news.dev.pr/stats?lang=en'), { items: [], translations: {}, feeds: [], alertAccounts: counts }).text();
  expect(html).toContain('2 active confirmed alert accounts');
  expect(html).toContain('Closed accounts: 1, excluded from the active count.');
  expect(html).not.toContain('one@example.org');
  expect(html).not.toContain('two@example.org');
  expect(html).not.toContain('old@example.org');
  expect(html).not.toContain('pending@example.org');
  expect(html).not.toContain('secreto');
  expect(html).not.toContain(OWNER_SIGNUP_EMAIL);
  const one = await renderer.fetch(new Request('https://news.dev.pr/stats?lang=es'), { items: [], translations: {}, feeds: [], alertAccounts: { active: 1, closed: 0 } }).text();
  expect(one).toContain('1 cuenta de alertas confirmada activa');
  expect(one).not.toContain('one@example.org');
  expect(one).not.toContain('secreto');
  const missing = await renderer.fetch(new Request('https://news.dev.pr/stats?lang=en'), { items: [], translations: {}, feeds: [], alertAccounts: null }).text();
  expect(missing).toContain('The confirmed alert account count is unavailable.');
  expect(missing).not.toContain('0 active confirmed alert accounts');
  const signup = await renderer.fetch(new Request('https://news.dev.pr/signup?lang=en'), { items: [], translations: {}, feeds: [] }).text();
  expect(signup).toContain('confirmed alert accounts');
  expect(signup).toContain('does not include your email address');
  expect(signup).not.toContain(OWNER_SIGNUP_EMAIL);
  expect(signup).not.toContain('/digest/subscribe');
  const about = await renderer.fetch(new Request('https://news.dev.pr/about?lang=en'), { items: [], translations: {}, feeds: [] }).text();
  expect(about).toContain('not a count of people');
  expect(about).not.toContain(OWNER_SIGNUP_EMAIL);
 });
});

it('keeps minimal history across outbox pruning and removes it on account closure', () => {
 const {db} = database();
 db.prepare("INSERT INTO alert_accounts(id,email,created_at) VALUES('history','test@example.com',1)").run();
 const payload=JSON.stringify({url:'https://example.com/history',phrases:['luma'],title:'Private body'});
 db.prepare("INSERT INTO alert_queue VALUES('q','history','https://example.com/history',?,1)").run(payload);
 db.prepare("INSERT INTO alert_outbox(id,kind,account_id,email,payload,state,created_at) VALUES('o','notify','history','test@example.com','pending-render','pending',1)").run();
 db.prepare("UPDATE alert_outbox SET payload=? WHERE id='o'").run(JSON.stringify({items:[JSON.parse(payload)],manageToken:'secret'}));
 db.exec("UPDATE alert_outbox SET state='sent',sent_at=2,attempts=1 WHERE id='o'; DELETE FROM alert_outbox WHERE id='o'; DELETE FROM alert_queue");
 const history=db.prepare('SELECT * FROM alert_delivery_history').get()!;
 expect(history.state).toBe('provider_accepted');
 expect(history.accepted_at).toBe(2);
 expect(JSON.stringify(history)).not.toMatch(/secret|test@example|Private body/);
 db.exec("UPDATE alert_accounts SET status='closed' WHERE id='history'");
 expect(db.prepare('SELECT COUNT(*) AS n FROM alert_delivery_history').get()!.n).toBe(0);
});
