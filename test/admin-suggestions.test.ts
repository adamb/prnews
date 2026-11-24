/**
 * Owner-only Source Suggestions Admin Dashboard — Workstream 3 security audit suite.
 *
 * Everything runs against the real migrations (0009, 0019, 0020) with the same in-memory
 * SQLite D1 mock the public suggestions suite uses. Turnstile and ImprovMX are mocked, so no
 * real verification or mail ever leaves the process.
 *
 * Coverage:
 *  - Strict owner lock: only beguelin@gmail.com ever obtains an admin_tokens row, an
 *    admin_outbox mail or an admin_sessions row — including case/whitespace variations,
 *    look-alike addresses, malformed addresses, and planted (forged) non-owner DB rows.
 *  - Single-use hashed tokens: SHA-256 only, replay/expiry/race rejection, session hashing.
 *  - Two-step scanner-safe redemption: GET renders a confirmation page without consuming the
 *    token; only POST consumes it; 303 strips the token; cookie flags on https and http.
 *  - Same-origin gate + per-session CSRF on status/delete/signout (401/403, no mutation).
 *  - SQL injection payloads in status/kind/q/id (%, _, \, ', ; DROP TABLE …).
 *  - Stored XSS / HTML injection on dashboard cards, search box, filter params and retry pages;
 *    javascript:/data: targets never become anchors.
 *  - CSV formula injection (=CMD(), +1+1, -2, @SUM, tab/CR prefixes) and CSV HTTP headers.
 *  - No-store/no-referrer/noindex/nosniff/strict CSP on every /admin* response, no analytics
 *    beacon, and no public links to /admin from / or /fuentes.
 *  - Outbox token scrubbing on 'sent', and no token/session/email ever reaching the logs.
 *  - Full end-to-end chain: signin → GET /admin/in → POST /admin/in → dashboard → status →
 *    CSV → delete → signout.
 *
 * Audit note (source intentionally not modified by this workstream; findings reported to the
 * orchestrator). Two source defects are exercised here and must be fixed before this file is
 * green:
 *  1) src/admin-suggestions.ts:304 aliases a count column `AS all`. ALL is a reserved SQLite
 *     keyword, so the counts query is a syntax error and every dashboard/CSV/list call fails
 *     (the route catches it and answers 503). Fix: `AS "all"` or rename the alias.
 *  2) src/admin-suggestions.ts:296 escapes LIKE metacharacters with `.replace(/[\\%_]/g,
 *     '\\$1')`, but the pattern has no capture group, so the replacement emits a literal `$1`
 *     instead of `\` + the matched character. Searches containing `%`, `_` or `\` match
 *     `$1`-ish text rather than the literal character. Not a SQL-injection hole (values stay
 *     bound), but a real search bug. Fix: `.replace(/[\\%_]/g, '\\$&')`.
 * With (1) applied the suite is 77/78; with (1) and (2) it is 78/78.
 */
import {describe,it,expect,vi,afterEach} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {
	ADMIN_COOKIE, ADMIN_EMAIL, adminConfigured, adminSessionFromCookie, deleteSuggestion,
	exportSuggestionsCsv, flushAdminOutbox, listSuggestions, publicAdminConfigured,
	redeemAdminToken, requestAdminSignin, signOutAdmin, updateSuggestionStatus,
} from '../src/admin-suggestions';
import {adminSuggestionsRoute} from '../src/admin-suggestions-http';
import type {SuggestionEnv} from '../src/suggestions';
import renderer from '../src/render';

const MIGRATIONS = ['0009_alerts.sql', '0019_source_suggestions.sql', '0020_admin_suggestions.sql'];
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
const baseEnv = (DB: D1Database): SuggestionEnv => ({
	DB, IMPROVMX_API_KEY: 'improv-fake-key', ALERTS_FROM: 'prnews', ALERTS_DOMAIN: 'code.pr',
	TURNSTILE_SECRET_KEY: 'turnstile-secret', TURNSTILE_SITE_KEY: '0xSITEKEY', TURNSTILE_HOSTNAMES: 'news.dev.pr',
	DIGEST_TOKEN_SECRET: 's'.repeat(40),
} as unknown as SuggestionEnv);

const get = (path: string, headers: Record<string, string> = {}): Request =>
	new Request(`https://news.dev.pr${path}`, { headers });
const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Request =>
	new Request(`https://news.dev.pr${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://news.dev.pr', ...headers },
		body: new URLSearchParams(fields).toString(),
	});

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
/** Siteverify success for the 'admin_signin' surface; every outbound mail is accepted. */
function providerOk(call: FetchCall): Response {
	if (call.url.includes('siteverify')) return Response.json({ success: true, hostname: 'news.dev.pr', action: 'admin_signin' });
	if (call.url.includes('/emails/outbound')) return Response.json({ id: 'mail-ref' });
	throw new Error('unexpected provider call: ' + call.url);
}
const sends = (mock: MockApi) => mock.calls.filter(c => c.url.includes('/emails/outbound'));
const verifies = (mock: MockApi) => mock.calls.filter(c => c.url.includes('siteverify'));
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const resetPace = (db: DatabaseSync) =>
	db.prepare("UPDATE alert_pace SET last_send=0, minute=0, minute_count=0 WHERE id='pace'").run();
const dayOf = (now: number) => Math.floor(now / 86400000);
const rows = (db: DatabaseSync, sql: string, ...args: any[]): any[] => db.prepare(sql).all(...args) as any[];
const row = (db: DatabaseSync, sql: string, ...args: any[]): any => db.prepare(sql).get(...args) as any;
const count = (db: DatabaseSync, table: string): number =>
	Number(row(db, `SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0);

let seedSeq = 0;
interface SeedOverrides { [key: string]: any }
/** Inserts one suggestion with valid constraints, including the 0020 admin_note column. */
function seedSuggestion(db: DatabaseSync, overrides: SeedOverrides = {}): any {
	const suggestion = {
		id: `sug-${++seedSeq}`,
		kind: 'site', name: 'Noticel', target: 'https://www.noticel.com/',
		notes: '', email: 'reader@example.org', language: 'es', status: 'pending',
		admin_note: '', created_at: Date.now() - 60000, confirmed_at: null,
		...overrides,
	};
	db.prepare('INSERT INTO source_suggestions(id,kind,name,target,notes,email,language,status,admin_note,created_at,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
		.run(suggestion.id, suggestion.kind, suggestion.name, suggestion.target, suggestion.notes, suggestion.email,
			suggestion.language, suggestion.status, suggestion.admin_note, suggestion.created_at, suggestion.confirmed_at);
	return suggestion;
}
function tokenFromMail(mock: MockApi): string {
	const mail = sends(mock).at(-1);
	const text = String(mail?.json?.text ?? '');
	return text.match(/\/admin\/in\?token=([a-f0-9]{64})/)?.[1] ?? '';
}
const setCookieOf = (response: Response | undefined): string => response?.headers.get('Set-Cookie') ?? '';
const cookiePair = (setCookie: string): string => setCookie.split(';')[0];
const csrfOf = (html: string): string => html.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1] ?? '';
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Full owner sign-in through the real backend, returning a usable session cookie + CSRF. */
async function signIn(env: SuggestionEnv, db: DatabaseSync, mock: MockApi) {
	resetPace(db);
	const verdict = await requestAdminSignin(env, { email: ADMIN_EMAIL, captcha: 'valid-token', language: 'es' });
	expect(verdict).toEqual({ ok: true, status: 'accepted' });
	const token = tokenFromMail(mock);
	expect(token).toMatch(/^[a-f0-9]{64}$/);
	const redeemed = await redeemAdminToken(env, token);
	expect(redeemed.ok).toBe(true);
	if (!redeemed.ok) throw new Error('owner sign-in failed');
	return { token, secret: redeemed.session.secret, csrf: redeemed.session.csrf };
}
const ownerCookie = (secret: string) => ({ Cookie: `${ADMIN_COOKIE}=${secret}` });

afterEach(() => { vi.restoreAllMocks(); });

/* ================================================================== owner lock */

describe('owner lock: only the operator mailbox is ever provisioned', () => {
	it('mints exactly one hashed token, one owner outbox mail and one send for the owner', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			resetPace(db);
			const verdict = await requestAdminSignin(env, { email: 'beguelin@gmail.com', captcha: 'valid-token', language: 'es' });
			expect(verdict).toEqual({ ok: true, status: 'accepted' });
			expect(ADMIN_EMAIL).toBe('beguelin@gmail.com');
			expect(count(db, 'admin_tokens')).toBe(1);
			expect(count(db, 'admin_outbox')).toBe(1);
			expect(count(db, 'admin_sessions')).toBe(0);

			const tokenRow = row(db, 'SELECT * FROM admin_tokens');
			expect(tokenRow.email).toBe(ADMIN_EMAIL);
			expect(tokenRow.token_hash).toMatch(/^[a-f0-9]{64}$/);
			expect(tokenRow.used_at).toBeNull();
			expect(tokenRow.expires_at).toBeGreaterThan(Date.now());

			const outboxRow = row(db, 'SELECT * FROM admin_outbox');
			expect(outboxRow.email).toBe(ADMIN_EMAIL);
			expect(outboxRow.state).toBe('sent');
			// The raw login token is scrubbed as soon as the provider accepts the mail.
			expect(outboxRow.payload).toBe('{}');
			expect(outboxRow.provider_ref).toBe('mail-ref');
			expect(typeof outboxRow.sent_at).toBe('number');

			const mail = sends(mock).at(-1)!;
			expect(String(mail.json.to)).toBe(ADMIN_EMAIL);
			const raw = tokenFromMail(mock);
			expect(JSON.stringify(tokenRow)).not.toContain(raw);
			expect(tokenRow.token_hash).toBe(sha256(raw));
		} finally { mock.restore(); }
	});

	const ownerVariations = [
		'beguelin@gmail.com',
		'BEGUELIN@GMAIL.COM',
		'Beguelin@Gmail.Com',
		' beguelin@gmail.com ',
		'\tbeguelin@gmail.com\n',
		'beguelin@gmail.com\x00',
		'  BEGUELIN@GMAIL.COM\t ',
	];
	it.each(ownerVariations)('normalizes case/whitespace and provisions the owner for %j', async email => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			resetPace(db);
			const verdict = await requestAdminSignin(env, { email, captcha: 'valid-token', language: 'es' });
			expect(verdict).toEqual({ ok: true, status: 'accepted' });
			expect(count(db, 'admin_tokens')).toBe(1);
			expect(row(db, 'SELECT email FROM admin_tokens').email).toBe(ADMIN_EMAIL);
			expect(count(db, 'admin_outbox')).toBe(1);
			expect(sends(mock)).toHaveLength(1);
			expect(String(sends(mock)[0].json.to)).toBe(ADMIN_EMAIL);
		} finally { mock.restore(); }
	});

	const nonOwners = [
		'evil@example.org',
		'beguelin@gmail.com.evil.com',
		'beguelin@gmail.co',
		'beguelin+tag@gmail.com',
		'BEGUELIN@GMAIL.COM.EVIL.COM',
		'beguelin@gmial.com',
		'beguelin@code.pr',
	];
	it.each(nonOwners)('answers identically and provisions nothing for non-owner %j', async email => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			resetPace(db);
			const verdict = await requestAdminSignin(env, { email, captcha: 'valid-token', language: 'es' });
			expect(verdict).toEqual({ ok: true, status: 'accepted' });
			expect(count(db, 'admin_tokens')).toBe(0);
			expect(count(db, 'admin_outbox')).toBe(0);
			expect(count(db, 'admin_sessions')).toBe(0);
			expect(sends(mock)).toHaveLength(0);
			// Only the Turnstile verification happened; no mail provider traffic.
			expect(verifies(mock)).toHaveLength(1);
		} finally { mock.restore(); }
	});

	const malformed = [
		'not-an-email', 'beguelin@gmail', '@gmail.com', 'beguelin@gmail.com x', '', 'a b@example.org',
		'beguelin@gmail.com@evil.com', 'beguelin@gm ail.com',
	];
	it.each(malformed)('rejects malformed address %j without writing or mailing', async email => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const verdict = await requestAdminSignin(env, { email, captcha: 'valid-token', language: 'es' });
			expect(verdict).toEqual({ ok: false, status: 'invalid' });
			expect(count(db, 'admin_tokens')).toBe(0);
			expect(count(db, 'admin_outbox')).toBe(0);
			expect(sends(mock)).toHaveLength(0);
		} finally { mock.restore(); }
	});

	it('refuses tokens and sessions for planted non-owner rows (forged email column)', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => { throw new Error('forged rows must not reach a provider'); });
		const attackerToken = 'a'.repeat(64), attackerSecret = 'b'.repeat(64);
		try {
			db.prepare('INSERT INTO admin_tokens(id,email,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)')
				.run('forged-token', 'attacker@evil.com', sha256(attackerToken), Date.now() + 600000, Date.now());
			db.prepare('INSERT INTO admin_sessions(id,email,token_hash,csrf,created_at,expires_at) VALUES(?,?,?,?,?,?)')
				.run('forged-session', 'attacker@evil.com', sha256(attackerSecret), 'c'.repeat(64), Date.now(), Date.now() + 86400000);

			expect(await redeemAdminToken(env, attackerToken)).toEqual({ ok: false, status: 'invalid' });
			expect(await adminSessionFromCookie(env, attackerSecret)).toBeNull();
			// The forged token was never claimed and no owner session was created.
			expect(row(db, "SELECT used_at FROM admin_tokens WHERE id='forged-token'").used_at).toBeNull();
			expect(count(db, 'admin_sessions')).toBe(1);
			expect(mock.calls).toHaveLength(0);
		} finally { mock.restore(); }
	});

	it('caps owner sign-in mail at the shared daily counter and still answers generically', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			db.prepare('INSERT INTO alert_limits(bucket,day,count) VALUES(?,?,?)').run('admin_signin', dayOf(Date.now()), 10);
			const verdict = await requestAdminSignin(env, { email: ADMIN_EMAIL, captcha: 'valid-token', language: 'es' });
			expect(verdict).toEqual({ ok: true, status: 'accepted' });
			expect(count(db, 'admin_tokens')).toBe(0);
			expect(count(db, 'admin_outbox')).toBe(0);
			expect(sends(mock)).toHaveLength(0);
		} finally { mock.restore(); }
	});

	it('silently drops a tokenless honeypot submission but lets a verified autofill pass', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			resetPace(db);
			const honeypot = await requestAdminSignin(env, { email: ADMIN_EMAIL, captcha: '', honeypot: 'spam bot', language: 'es' });
			expect(honeypot).toEqual({ ok: true, status: 'accepted' });
			expect(count(db, 'admin_tokens')).toBe(0);
			expect(mock.calls).toHaveLength(0);

			const autofill = await requestAdminSignin(env, { email: ADMIN_EMAIL, captcha: 'valid-token', honeypot: 'browser autofill', language: 'es' });
			expect(autofill).toEqual({ ok: true, status: 'accepted' });
			expect(count(db, 'admin_tokens')).toBe(1);
			expect(sends(mock)).toHaveLength(1);
		} finally { mock.restore(); }
	});

	it('fails closed when the mail provider or the Turnstile triangle is missing', async () => {
		const { DB, db } = database();
		const mock = mockFetch(() => { throw new Error('paused endpoint must not call a provider'); });
		try {
			const noMail = { ...baseEnv(DB), IMPROVMX_API_KEY: undefined } as unknown as SuggestionEnv;
			const noCaptcha = { ...baseEnv(DB), TURNSTILE_SECRET_KEY: undefined } as unknown as SuggestionEnv;
			const noSiteKey = { ...baseEnv(DB), TURNSTILE_SITE_KEY: undefined } as unknown as SuggestionEnv;
			expect(adminConfigured(noMail)).toBe(false);
			expect(publicAdminConfigured(noMail)).toBe(false);
			expect(publicAdminConfigured(noCaptcha)).toBe(false);
			expect(publicAdminConfigured(noSiteKey)).toBe(false);
			expect(await requestAdminSignin(noMail, { email: ADMIN_EMAIL, captcha: 'valid-token' }))
				.toEqual({ ok: false, status: 'unavailable' });
			expect(await redeemAdminToken(noMail, 'a'.repeat(64))).toEqual({ ok: false, status: 'unavailable' });
			expect(count(db, 'admin_tokens')).toBe(0);
			expect(mock.calls).toHaveLength(0);
		} finally { mock.restore(); }
	});
});

/* ================================================================== tokens & sessions */

describe('single-use hashed tokens and scoped sessions', () => {
	it('stores only the SHA-256 hash of the token and of the session secret', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const { token, secret, csrf } = await signIn(env, db, mock);
			const tokenRow = row(db, 'SELECT * FROM admin_tokens');
			expect(tokenRow.token_hash).toBe(sha256(token));
			expect(JSON.stringify(tokenRow)).not.toContain(token);

			const sessionRow = row(db, 'SELECT * FROM admin_sessions');
			expect(sessionRow.email).toBe(ADMIN_EMAIL);
			expect(sessionRow.token_hash).toBe(sha256(secret));
			expect(JSON.stringify(sessionRow)).not.toContain(secret);
			expect(sessionRow.csrf).toBe(csrf);
			expect(csrf).toMatch(/^[a-f0-9]{64}$/);
			expect(sessionRow.expires_at - sessionRow.created_at).toBe(7 * 86400000);

			const session = await adminSessionFromCookie(env, secret);
			expect(session).toEqual({ id: sessionRow.id, email: ADMIN_EMAIL, csrf, expiresAt: sessionRow.expires_at });
			expect(await adminSessionFromCookie(env, undefined)).toBeNull();
			expect(await adminSessionFromCookie(env, 'x'.repeat(129))).toBeNull();
			expect(await adminSessionFromCookie(env, 'not-a-secret')).toBeNull();
		} finally { mock.restore(); }
	});

	it('rejects replay, expiry and concurrent double redemption of the same token', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const { token } = await signIn(env, db, mock);
			expect(await redeemAdminToken(env, token)).toEqual({ ok: false, status: 'invalid' });
			expect(count(db, 'admin_sessions')).toBe(1);

			resetPace(db);
			const second = await requestAdminSignin(env, { email: ADMIN_EMAIL, captcha: 'valid-token', language: 'es' });
			expect(second.ok).toBe(true);
			const expiredToken = tokenFromMail(mock);
			db.prepare('UPDATE admin_tokens SET expires_at=? WHERE used_at IS NULL').run(Date.now() - 1);
			expect(await redeemAdminToken(env, expiredToken)).toEqual({ ok: false, status: 'invalid' });
			expect(count(db, 'admin_sessions')).toBe(1);

			resetPace(db);
			const third = await requestAdminSignin(env, { email: ADMIN_EMAIL, captcha: 'valid-token', language: 'es' });
			expect(third.ok).toBe(true);
			const raced = tokenFromMail(mock);
			const [a, b] = await Promise.all([redeemAdminToken(env, raced), redeemAdminToken(env, raced)]);
			expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
			expect(count(db, 'admin_sessions')).toBe(2);
		} finally { mock.restore(); }
	});

	it.each([
		'',
		'not-a-token',
		'A'.repeat(64),
		'0'.repeat(63),
		'0'.repeat(65),
		`${'0'.repeat(64)}\r\nBcc: attacker@evil.com`,
		`${'0'.repeat(64)} `,
	])('rejects malformed token %j without a session', async token => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => { throw new Error('malformed tokens never reach a provider'); });
		try {
			expect(await redeemAdminToken(env, token)).toEqual({ ok: false, status: 'invalid' });
			expect(count(db, 'admin_sessions')).toBe(0);
			expect(mock.calls).toHaveLength(0);
		} finally { mock.restore(); }
	});

	it('signs out exactly the presented session and tolerates unknown secrets', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const { secret } = await signIn(env, db, mock);
			await signOutAdmin(env, secret);
			expect(count(db, 'admin_sessions')).toBe(0);
			expect(await adminSessionFromCookie(env, secret)).toBeNull();
			await expect(signOutAdmin(env, secret)).resolves.toBeUndefined();
			await expect(signOutAdmin(env, undefined)).resolves.toBeUndefined();
		} finally { mock.restore(); }
	});
});

/* ================================================================== two-step redemption */

describe('scanner-safe two-step magic-link redemption (HTTP)', () => {
	it('renders a confirmation page on GET without consuming, then consumes only on POST and strips the token', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			resetPace(db);
			const signin = await adminSuggestionsRoute(post('/admin/signin?lang=es', {
				email: ADMIN_EMAIL, lang: 'es', 'cf-turnstile-response': 'valid-token',
			}), env);
			expect(signin?.status).toBe(202);
			const token = tokenFromMail(mock);
			expect(token).toMatch(/^[a-f0-9]{64}$/);

			for (let i = 0; i < 2; i++) {
				const confirm = await adminSuggestionsRoute(get(`/admin/in?token=${token}&lang=es`), env);
				expect(confirm?.status).toBe(200);
				const html = await confirm!.text();
				expect(html).toContain(`name="token" value="${token}"`);
				expect(html).toContain('method="post" action="/admin/in?lang=es"');
				expect(html).toContain('un solo uso');
				expect(confirm!.headers.get('Set-Cookie')).toBeNull();
				expect(confirm!.headers.get('Cache-Control')).toBe('no-store');
			}
			// The scanner-visited link is still unused and no session exists yet.
			expect(row(db, 'SELECT used_at FROM admin_tokens').used_at).toBeNull();
			expect(count(db, 'admin_sessions')).toBe(0);

			const redeem = await adminSuggestionsRoute(post('/admin/in?lang=es', { token, lang: 'es' }), env);
			expect(redeem?.status).toBe(303);
			expect(redeem?.headers.get('Location')).toBe('/admin/suggestions?lang=es');
			expect(redeem?.headers.get('Location')).not.toContain(token);
			const setCookie = setCookieOf(redeem);
			expect(setCookie).toContain(`${ADMIN_COOKIE}=`);
			expect(setCookie).toContain('HttpOnly');
			expect(setCookie).toContain('SameSite=Lax');
			expect(setCookie).toContain('Path=/admin');
			expect(setCookie).toContain('Secure');
			expect(setCookie).toMatch(/Max-Age=\d+/);
			expect(typeof row(db, 'SELECT used_at FROM admin_tokens').used_at).toBe('number');
			expect(count(db, 'admin_sessions')).toBe(1);

			const replay = await adminSuggestionsRoute(post('/admin/in?lang=es', { token, lang: 'es' }), env);
			expect(replay?.status).toBe(400);
			expect(await replay?.text()).toContain('Este enlace no es válido');
			expect(replay?.headers.get('Set-Cookie')).toBeNull();
			expect(count(db, 'admin_sessions')).toBe(1);
		} finally { mock.restore(); }
	});

	it('rejects an expired token on POST without opening a session', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			resetPace(db);
			await requestAdminSignin(env, { email: ADMIN_EMAIL, captcha: 'valid-token', language: 'es' });
			const token = tokenFromMail(mock);
			db.prepare('UPDATE admin_tokens SET expires_at=?').run(Date.now() - 1);
			const response = await adminSuggestionsRoute(post('/admin/in?lang=en', { token, lang: 'en' }), env);
			expect(response?.status).toBe(400);
			expect(await response?.text()).toContain('This link is invalid');
			expect(count(db, 'admin_sessions')).toBe(0);
			expect(row(db, 'SELECT used_at FROM admin_tokens').used_at).toBeNull();
		} finally { mock.restore(); }
	});

	it.each(['', 'deadbeef', 'A'.repeat(64), `${'a'.repeat(64)}%0D%0AX-Evil: 1`])(
		'rejects invalid token shape %j on GET and POST', async token => {
			const { DB, db } = database(); const env = baseEnv(DB);
			const mock = mockFetch(() => { throw new Error('invalid shapes never reach a provider'); });
			try {
				const query = `/admin/in?token=${encodeURIComponent(token)}`;
				const confirm = await adminSuggestionsRoute(get(query), env);
				expect(confirm?.status).toBe(400);
				const confirmHtml = await confirm!.text();
				expect(confirmHtml).toContain('Este enlace no es válido');
				// Never rendered back as a redeemable field and never turned into a cookie.
				expect(confirmHtml).not.toContain('name="token"');
				expect(confirm!.headers.get('Set-Cookie')).toBeNull();

				const redeem = await adminSuggestionsRoute(post('/admin/in', { token }), env);
				expect(redeem?.status).toBe(400);
				// The POST response never echoes the submitted token (it lives only in the body).
				if (token) expect(await redeem?.text()).not.toContain(token);
				expect(count(db, 'admin_sessions')).toBe(0);
				expect(mock.calls).toHaveLength(0);
			} finally { mock.restore(); }
		});

	it('marks the cookie Secure on https and omits Secure on plain http', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => { throw new Error('no provider traffic is needed for a planted token'); });
		try {
			const raw = 'd'.repeat(64);
			db.prepare('INSERT INTO admin_tokens(id,email,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)')
				.run('planted', ADMIN_EMAIL, sha256(raw), Date.now() + 600000, Date.now());
			const plain = new Request('http://news.dev.pr/admin/in?lang=es', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://news.dev.pr' },
				body: new URLSearchParams({ token: raw, lang: 'es' }).toString(),
			});
			const response = await adminSuggestionsRoute(plain, env);
			expect(response?.status).toBe(303);
			const setCookie = setCookieOf(response);
			expect(setCookie).toContain('HttpOnly');
			expect(setCookie).toContain('SameSite=Lax');
			expect(setCookie).toContain('Path=/admin');
			expect(setCookie).not.toContain('Secure');
			expect(mock.calls).toHaveLength(0);
		} finally { mock.restore(); }
	});

	it('rejects a cross-site POST to /admin/in before redeeming', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			resetPace(db);
			await requestAdminSignin(env, { email: ADMIN_EMAIL, captcha: 'valid-token', language: 'es' });
			const token = tokenFromMail(mock);
			const response = await adminSuggestionsRoute(post('/admin/in', { token }, {
				Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site',
			}), env);
			expect(response?.status).toBe(403);
			expect(row(db, 'SELECT used_at FROM admin_tokens').used_at).toBeNull();
			expect(count(db, 'admin_sessions')).toBe(0);
		} finally { mock.restore(); }
	});
});

/* ================================================================== CSRF + same-origin */

describe('same-origin gate and CSRF on admin mutations', () => {
	it('rejects mutations without a session (401) and with a wrong/absent CSRF (403)', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const target = seedSuggestion(db, { id: 'csrf-target', status: 'pending' });
			const { secret, csrf } = await signIn(env, db, mock);
			const cookie = ownerCookie(secret);

			for (const path of ['/admin/suggestions/status', '/admin/suggestions/delete', '/admin/signout']) {
				const anonymous = await adminSuggestionsRoute(post(path, { csrf, id: target.id, status: 'reviewed' }), env);
				expect(anonymous?.status).toBe(401);
				const noCsrf = await adminSuggestionsRoute(post(path, { id: target.id, status: 'reviewed' }, cookie), env);
				expect(noCsrf?.status).toBe(403);
				const wrongCsrf = await adminSuggestionsRoute(post(path, { csrf: 'e'.repeat(64), id: target.id, status: 'reviewed' }, cookie), env);
				expect(wrongCsrf?.status).toBe(403);
			}
			expect(row(db, "SELECT status FROM source_suggestions WHERE id='csrf-target'").status).toBe('pending');
			expect(count(db, 'admin_sessions')).toBe(1);

			// A cross-site POST is stopped at the origin gate even with the right CSRF.
			const crossSite = await adminSuggestionsRoute(post('/admin/suggestions/status', {
				csrf, id: target.id, status: 'reviewed',
			}, { ...cookie, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }), env);
			expect(crossSite?.status).toBe(403);
			expect(await crossSite?.text()).toContain('verificación de origen');
			expect(row(db, "SELECT status FROM source_suggestions WHERE id='csrf-target'").status).toBe('pending');
		} finally { mock.restore(); }
	});

	it('accepts a same-origin sign-out only with the matching CSRF and drops the cookie', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const { secret, csrf } = await signIn(env, db, mock);
			const cookie = ownerCookie(secret);
			const wrong = await adminSuggestionsRoute(post('/admin/signout', { csrf: 'f'.repeat(64) }, cookie), env);
			expect(wrong?.status).toBe(403);
			expect(count(db, 'admin_sessions')).toBe(1);

			const out = await adminSuggestionsRoute(post('/admin/signout?lang=en', { csrf, lang: 'en' }, cookie), env);
			expect(out?.status).toBe(303);
			expect(out?.headers.get('Location')).toBe('/admin?lang=en');
			const setCookie = setCookieOf(out);
			expect(setCookie).toContain('Max-Age=0');
			expect(setCookie).toContain('Path=/admin');
			expect(count(db, 'admin_sessions')).toBe(0);

			const after = await adminSuggestionsRoute(post('/admin/suggestions/status', { csrf, id: 'x', status: 'reviewed' }, cookie), env);
			expect(after?.status).toBe(401);
		} finally { mock.restore(); }
	});

	it('rejects an expired session on every mutation route with 401 and on GET with the sign-in page', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const { secret, csrf } = await signIn(env, db, mock);
			const cookie = ownerCookie(secret);
			db.prepare('UPDATE admin_sessions SET expires_at=?').run(Date.now() - 1);
			for (const path of ['/admin/suggestions/status', '/admin/suggestions/delete', '/admin/signout']) {
				const response = await adminSuggestionsRoute(post(path, { csrf, id: 'x', status: 'reviewed' }, cookie), env);
				expect(response?.status).toBe(401);
				expect(await response?.text()).toContain('Sesión vencida');
			}
			const page = await adminSuggestionsRoute(get('/admin/suggestions', cookie), env);
			expect(page?.status).toBe(200);
			const html = await page!.text();
			expect(html).toContain('Acceso restringido al propietario');
			expect(html).not.toContain('Cerrar sesión');
		} finally { mock.restore(); }
	});

	it('validates the status value and the row id before touching the database', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const target = seedSuggestion(db, { id: 'status-target', status: 'pending' });
			const { secret, csrf } = await signIn(env, db, mock);
			const cookie = ownerCookie(secret);
			const invalidStatus = await adminSuggestionsRoute(post('/admin/suggestions/status', {
				csrf, id: target.id, status: 'confirmed; DROP TABLE source_suggestions',
			}, cookie), env);
			expect(invalidStatus?.status).toBe(403);
			const missingId = await adminSuggestionsRoute(post('/admin/suggestions/status', { csrf, status: 'reviewed' }, cookie), env);
			expect(missingId?.status).toBe(403);
			const missingDeleteId = await adminSuggestionsRoute(post('/admin/suggestions/delete', { csrf }, cookie), env);
			expect(missingDeleteId?.status).toBe(403);
			expect(row(db, "SELECT status FROM source_suggestions WHERE id='status-target'").status).toBe('pending');
			expect(count(db, 'source_suggestions')).toBe(1);
		} finally { mock.restore(); }
	});

	it('honors browser Sec-Fetch-Site same-origin evidence when Origin is absent', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const target = seedSuggestion(db, { id: 'fetch-meta', status: 'pending' });
			const { secret, csrf } = await signIn(env, db, mock);
			const request = new Request('https://news.dev.pr/admin/suggestions/status?lang=es', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Sec-Fetch-Site': 'same-origin',
					Cookie: `${ADMIN_COOKIE}=${secret}`,
				},
				body: new URLSearchParams({ csrf, id: target.id, status: 'reviewed', lang: 'es' }).toString(),
			});
			const response = await adminSuggestionsRoute(request, env);
			expect(response?.status).toBe(303);
			expect(row(db, "SELECT status FROM source_suggestions WHERE id='fetch-meta'").status).toBe('reviewed');
		} finally { mock.restore(); }
	});

	it('blocks a cross-site sign-in request before Turnstile or any database write', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => { throw new Error('blocked sign-in must not call a provider'); });
		try {
			const response = await adminSuggestionsRoute(post('/admin/signin', {
				email: ADMIN_EMAIL, 'cf-turnstile-response': 'valid-token',
			}, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }), env);
			expect(response?.status).toBe(403);
			expect(await response?.text()).toContain('verificación de origen');
			expect(count(db, 'admin_tokens')).toBe(0);
			expect(count(db, 'admin_outbox')).toBe(0);
			expect(mock.calls).toHaveLength(0);
		} finally { mock.restore(); }
	});
});

/* ================================================================== SQL injection */

describe('SQL injection: every filter and mutation stays bound/parameterized', () => {
	const injectionPayloads = [
		"' OR '1'='1",
		"'; DROP TABLE source_suggestions; --",
		'" OR 1=1 --',
		'pending UNION SELECT 1,2,3',
		"%' OR name LIKE '%",
	];
	it.each(injectionPayloads)('ignores injection payload %j in status and kind filters', async payload => {
		const { DB, db } = database(); const env = baseEnv(DB);
		seedSuggestion(db, { id: 'legit-1', name: 'Legit One', status: 'pending' });
		seedSuggestion(db, { id: 'legit-2', name: 'Legit Two', status: 'confirmed', kind: 'influencer' });
		const all = await listSuggestions(env);
		expect(all.rows).toHaveLength(2);
		const status = await listSuggestions(env, { status: payload });
		expect(status.rows).toHaveLength(2);
		expect(status.counts).toEqual({ all: 2, confirmed: 1, pending: 1, reviewed: 0, rejected: 0 });
		const kind = await listSuggestions(env, { kind: payload });
		expect(kind.rows).toHaveLength(2);
		expect(rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='source_suggestions'")).toHaveLength(1);
	});

	it('keeps stored injection text literal and never widens the result set or drops the table', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const stored = seedSuggestion(db, {
			id: 'stored', name: "Robert'); DROP TABLE suggestions;--",
			target: 'https://example.com/x', notes: "' OR '1'='1", email: 'stored@example.org',
		});
		seedSuggestion(db, { id: 'plain', name: 'Plain', status: 'confirmed' });

		const literal = await listSuggestions(env, { q: stored.name });
		expect(literal.rows).toHaveLength(1);
		expect(literal.rows[0].id).toBe('stored');
		expect(row(db, "SELECT notes FROM source_suggestions WHERE id='stored'").notes).toBe("' OR '1'='1");

		const tautology = await listSuggestions(env, { q: "' OR '1'='1" });
		expect(tautology.rows.map(r => r.id)).toEqual(['stored']);
		const drop = await listSuggestions(env, { q: "'; DROP TABLE source_suggestions; --" });
		expect(drop.rows).toHaveLength(0);
		expect(count(db, 'source_suggestions')).toBe(2);
		expect(rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='source_suggestions'")).toHaveLength(1);
	});

	it('escapes LIKE metacharacters instead of honoring them as wildcards', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		seedSuggestion(db, { id: 'percent', name: '100% real', email: 'pct@example.org' });
		seedSuggestion(db, { id: 'xname', name: '100X real', email: 'x@example.org' });
		seedSuggestion(db, { id: 'under', name: 'a_b token', email: 'u@example.org' });
		seedSuggestion(db, { id: 'back', name: 'back\\slash', email: 'b@example.org' });

		const all = await listSuggestions(env, { q: '100' });
		expect(all.rows.map(r => r.id).sort()).toEqual(['percent', 'xname']);

		// A literal '%' must not behave as a match-all wildcard.
		const percent = await listSuggestions(env, { q: '%' });
		expect(percent.rows.length).toBeLessThan(percent.counts.all);
		expect(percent.rows.map(r => r.id)).not.toContain('xname');
		// If escaping were corrected (see audit note), only the literal '%' row may match.
		for (const found of percent.rows) expect(found.name).toContain('%');

		const underscore = await listSuggestions(env, { q: '_' });
		expect(underscore.rows.length).toBeLessThan(underscore.counts.all);
		for (const found of underscore.rows) expect(found.name).toContain('_');

		const backslash = await listSuggestions(env, { q: '\\' });
		expect(backslash.rows.length).toBeLessThan(backslash.counts.all);
		expect(rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='source_suggestions'")).toHaveLength(1);
	});

	// Regression: the escape replacement must emit `\` + the matched character. The shipped
	// `.replace(/[\\%_]/g, '\\$1')` has no capture group, so `$1` stays literal and searches
	// containing %, _ or \ match nothing. Fix: `.replace(/[\\%_]/g, '\\$&')`.
	it('finds literal LIKE metacharacters in names, notes and emails', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		seedSuggestion(db, { id: 'percent', name: '100% real', email: 'pct@example.org' });
		seedSuggestion(db, { id: 'xname', name: '100X real', email: 'x@example.org' });
		seedSuggestion(db, { id: 'under', name: 'a_b token', notes: 'has_underscore', email: 'u@example.org' });
		seedSuggestion(db, { id: 'back', name: 'back\\slash', email: 'b@example.org' });

		expect((await listSuggestions(env, { q: '100%' })).rows.map(r => r.id)).toEqual(['percent']);
		expect((await listSuggestions(env, { q: 'a_b' })).rows.map(r => r.id)).toEqual(['under']);
		expect((await listSuggestions(env, { q: 'has_underscore' })).rows.map(r => r.id)).toEqual(['under']);
		expect((await listSuggestions(env, { q: 'back\\slash' })).rows.map(r => r.id)).toEqual(['back']);
		// A literal '%' must not match everything else.
		expect((await listSuggestions(env, { q: '%' })).rows.map(r => r.id)).toEqual(['percent']);
	});

	it('clamps limits and search length without throwing', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		for (let i = 0; i < 3; i++) seedSuggestion(db, { id: `row-${i}`, name: `Row ${i}` });
		expect((await listSuggestions(env, { limit: 0 })).rows).toHaveLength(1);
		expect((await listSuggestions(env, { limit: 2 })).rows).toHaveLength(2);
		expect((await listSuggestions(env, { limit: 10000 })).rows).toHaveLength(3);
		// A non-integer limit falls back to the default page size (200), clamped to all rows here.
		expect((await listSuggestions(env, { limit: 2.5 as any })).rows).toHaveLength(3);
		expect((await listSuggestions(env, { q: 'x'.repeat(1000) })).rows).toHaveLength(0);
	});

	it('does not let injected ids or statuses mutate or delete unrelated rows', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		seedSuggestion(db, { id: 'victim', name: 'Victim', status: 'pending' });
		expect(await updateSuggestionStatus(env, { id: "x' OR '1'='1", status: 'reviewed' })).toBe(false);
		expect(await updateSuggestionStatus(env, { id: 'victim', status: 'nope' as any })).toBe(false);
		expect(await updateSuggestionStatus(env, { id: '', status: 'reviewed' })).toBe(false);
		expect(await deleteSuggestion(env, "victim' OR '1'='1")).toBe(false);
		expect(await deleteSuggestion(env, '')).toBe(false);
		expect(row(db, "SELECT status FROM source_suggestions WHERE id='victim'").status).toBe('pending');
		expect(count(db, 'source_suggestions')).toBe(1);

		expect(await updateSuggestionStatus(env, { id: 'victim', status: 'reviewed' })).toBe(true);
		expect(row(db, "SELECT status FROM source_suggestions WHERE id='victim'").status).toBe('reviewed');
		expect(await deleteSuggestion(env, 'victim')).toBe(true);
		expect(count(db, 'source_suggestions')).toBe(0);
	});

	it('sanitizes the admin note (LF only, control chars removed, 500-char cap)', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		seedSuggestion(db, { id: 'note' });
		await updateSuggestionStatus(env, {
			id: 'note', status: 'reviewed',
			adminNote: 'Line1\r\nLine2\tX\x00<script>alert(1)</script>',
		});
		expect(row(db, 'SELECT admin_note FROM source_suggestions').admin_note).toBe('Line1\nLine2X<script>alert(1)</script>');
		await updateSuggestionStatus(env, { id: 'note', status: 'reviewed', adminNote: 'n'.repeat(900) });
		expect(row(db, 'SELECT admin_note FROM source_suggestions').admin_note).toHaveLength(500);
	});

	it('keeps injection payloads inert over HTTP (filters, search, id)', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			seedSuggestion(db, { id: 'http-victim', name: 'Victim', status: 'pending' });
			const { secret, csrf } = await signIn(env, db, mock);
			const cookie = ownerCookie(secret);
			const filters = encodeURIComponent("'; DROP TABLE source_suggestions; --");
			const page = await adminSuggestionsRoute(get(`/admin/suggestions?status=${filters}&kind=${filters}&q=${filters}&lang=es`, cookie), env);
			expect(page?.status).toBe(200);
			const html = await page!.text();
			// The hostile filter is ignored (never reflected raw) and the table survives.
			expect(html).not.toContain("'; DROP TABLE source_suggestions; --");
			expect(html).toContain('Sugerencias de fuentes');
			expect(count(db, 'source_suggestions')).toBe(1);

			const mutation = await adminSuggestionsRoute(post('/admin/suggestions/delete?lang=es', {
				csrf, id: "http-victim' OR '1'='1", lang: 'es',
			}, cookie), env);
			expect(mutation?.status).toBe(303);
			expect(count(db, 'source_suggestions')).toBe(1);
			expect(row(db, "SELECT status FROM source_suggestions WHERE id='http-victim'").status).toBe('pending');
		} finally { mock.restore(); }
	});
});

/* ================================================================== stored XSS */

describe('stored XSS and HTML injection', () => {
	it('escapes every card field and never links javascript:/data: targets', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const xss = seedSuggestion(db, {
				id: 'xss-card', name: '<script>alert("xss")</script>',
				target: 'javascript:alert(document.domain)',
				notes: '<img src=x onerror="alert(1)">\nLine 2',
				email: '" onmouseover="alert(1)',
				admin_note: '<svg onload=alert(1)>',
			});
			seedSuggestion(db, { id: 'data-card', target: 'data:text/html,<script>alert(1)</script>' });
			seedSuggestion(db, { id: 'safe-card', target: 'https://safe.example/path?q=1&x=2' });
			const { secret } = await signIn(env, db, mock);
			const page = await adminSuggestionsRoute(get('/admin/suggestions?lang=es', ownerCookie(secret)), env);
			expect(page?.status).toBe(200);
			const html = await page!.text();

			expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
			expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
			expect(html).toContain('mailto:&quot; onmouseover=&quot;alert(1)');
			expect(html).toContain('&lt;svg onload=alert(1)&gt;');
			expect(html).not.toContain(xss.name);
			expect(html).not.toContain('<img src=x');
			expect(html).not.toContain('<svg onload');
			expect(html).not.toContain('" onmouseover="alert(1)');

			expect(html).not.toContain('href="javascript:');
			expect(html).not.toContain('href="data:');
			expect(html).toContain('javascript:alert(document.domain)');
			expect(html).toContain('data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;');

			expect(html).toContain('href="https://safe.example/path?q=1&amp;x=2"');
			expect(html).toContain('rel="noopener noreferrer"');
		} finally { mock.restore(); }
	});

	it('escapes the search box and never reflects status/kind injection parameters raw', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			seedSuggestion(db, { id: 'search-row', name: 'Searchable' });
			const { secret } = await signIn(env, db, mock);
			const payload = '<script>alert(1)</script>';
			const page = await adminSuggestionsRoute(get(
				`/admin/suggestions?lang=es&q=${encodeURIComponent(payload)}&status=${encodeURIComponent(payload)}&kind=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`,
				ownerCookie(secret),
			), env);
			expect(page?.status).toBe(200);
			const html = await page!.text();
			expect(html).toContain('value="&lt;script&gt;alert(1)&lt;/script&gt;"');
			expect(html).not.toContain(payload);
			expect(html).not.toContain('"><img src=x onerror=alert(1)>');
			expect(html).not.toContain('<img src=x');
			// Filter tabs still work and are not poisoned by the invalid params.
			expect(html).toContain('Todas');
			expect(html).toContain('No hay sugerencias que coincidan con este filtro.');
		} finally { mock.restore(); }
	});

	it('escapes retained email on the captcha and validation retry pages', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const failing = mockFetch(call => call.url.includes('siteverify')
			? Response.json({ success: false, 'error-codes': ['invalid-input-response'] })
			: Response.json({}));
		try {
			const payload = '<img src=x onerror=alert(1)>" onfocus="alert(1)';
			const captcha = await adminSuggestionsRoute(post('/admin/signin?lang=es', {
				email: payload, 'cf-turnstile-response': 'expired-token-abc123',
			}), env);
			expect(captcha?.status).toBe(400);
			const captchaHtml = await captcha!.text();
			expect(captchaHtml).toContain('No pudimos verificar');
			expect(captchaHtml).toContain('&lt;img src=x onerror=alert(1)&gt;&quot; onfocus=&quot;alert(1)');
			expect(captchaHtml).not.toContain('<img src=x');
			expect(captchaHtml).not.toContain('" onfocus="alert(1)');
			expect(captchaHtml).not.toContain('expired-token-abc123');
		} finally { failing.restore(); }

		const passing = mockFetch(providerOk);
		try {
			const invalid = await adminSuggestionsRoute(post('/admin/signin?lang=es', {
				email: 'not-an-email<script>alert(1)</script>', 'cf-turnstile-response': 'valid-token',
			}), env);
			expect(invalid?.status).toBe(400);
			const invalidHtml = await invalid!.text();
			expect(invalidHtml).toContain('Ingresa un correo electrónico válido');
			expect(invalidHtml).toContain('not-an-email&lt;script&gt;alert(1)&lt;/script&gt;');
			expect(invalidHtml).not.toContain('<script>alert(1)</script>');
		} finally { passing.restore(); }
	});

	it('answers a database failure with a generic 503 page that leaks no error text', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const broken = {
			...env,
			DB: { prepare() { throw new Error('D1_ERROR: secret table exploded'); } } as unknown as D1Database,
		} as SuggestionEnv;
		const response = await adminSuggestionsRoute(get('/admin/suggestions', {
			Cookie: `${ADMIN_COOKIE}=${'a'.repeat(64)}`,
		}), broken);
		expect(response?.status).toBe(503);
		const html = await response!.text();
		expect(html).toContain('Actualizando');
		expect(html).not.toContain('D1_ERROR');
		expect(html).not.toContain('secret table exploded');
		expect(response?.headers.get('Cache-Control')).toBe('no-store');
	});
});

/* ================================================================== CSV export */

describe('CSV export', () => {
	const dangerous = ['=CMD()', '+1+1', '-2', '@SUM(A1)', '\t=1+1', '\r=1+1'];
	it('neutralizes spreadsheet formulas and quotes embedded commas/quotes/newlines', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		for (let i = 0; i < dangerous.length; i++) {
			seedSuggestion(db, { id: `formula-${i}`, name: dangerous[i], target: 'https://example.com/', email: `f${i}@example.org` });
		}
		seedSuggestion(db, { id: 'quoted', name: '"quoted, comma"', notes: 'line\nbreak', target: 'https://example.com/' });
		const csv = await exportSuggestionsCsv(env);
		const header = csv.split('\n')[0];
		expect(header).toBe('kind,name,target,notes,email,language,status,admin_note,created_at,confirmed_at');

		for (const value of dangerous) {
			expect(csv).toContain(`'${value}`);
		}
		// No cell may begin with a formula trigger, even after a comma or newline.
		expect(csv).not.toMatch(/(^|[,\n])[=+@]/);
		expect(csv).not.toMatch(/(^|[,\n])-[0-9]/);
		expect(csv).not.toMatch(/(^|[,\n])\t/);
		// Quotes are doubled and comma/newline cells are quoted.
		expect(csv).toContain('"""quoted, comma"""');
		expect(csv).toContain('"line\nbreak"');
	});

	it('serves the CSV only to a live session with attachment headers and no-store', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			seedSuggestion(db, { id: 'csv-row', name: '=HYPERLINK("http://evil.example")', status: 'confirmed' });
			const anonymous = await adminSuggestionsRoute(get('/admin/suggestions.csv?lang=es'), env);
			expect(anonymous?.status).toBe(303);
			expect(anonymous?.headers.get('Location')).toBe('/admin');
			expect(await anonymous?.text()).toBe('');

			const { secret } = await signIn(env, db, mock);
			const response = await adminSuggestionsRoute(get('/admin/suggestions.csv?lang=es', ownerCookie(secret)), env);
			expect(response?.status).toBe(200);
			expect(response?.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
			expect(response?.headers.get('Content-Disposition')).toContain('attachment');
			expect(response?.headers.get('Content-Disposition')).toContain('suggestions.csv');
			expect(response?.headers.get('Cache-Control')).toBe('no-store');
			expect(response?.headers.get('X-Content-Type-Options')).toBe('nosniff');
			const csv = await response!.text();
			expect(csv).toContain("'=HYPERLINK");
			expect(csv).not.toMatch(/(^|[,\n])=/);
		} finally { mock.restore(); }
	});
});

/* ================================================================== headers & privacy */

describe('headers, privacy and public surface', () => {
	it('carries no-store, no-referrer, noindex, nosniff and a strict CSP on every /admin* response', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			seedSuggestion(db, { id: 'header-row' });
			const { secret } = await signIn(env, db, mock);
			const cookie = ownerCookie(secret);
			const responses = [
				await adminSuggestionsRoute(get('/admin'), env),
				await adminSuggestionsRoute(get('/admin?lang=en'), env),
				await adminSuggestionsRoute(new Request('https://news.dev.pr/admin', { method: 'HEAD' }), env),
				await adminSuggestionsRoute(get('/admin/suggestions', cookie), env),
				await adminSuggestionsRoute(get('/admin/in?token=deadbeef'), env),
				await adminSuggestionsRoute(get(`/admin/in?token=${'a'.repeat(64)}`), env),
				await adminSuggestionsRoute(post('/admin/in', { token: 'bad' }), env),
				await adminSuggestionsRoute(post('/admin/signin', { email: ADMIN_EMAIL }, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }), env),
				await adminSuggestionsRoute(post('/admin/signout', {}), env),
				await adminSuggestionsRoute(post('/admin/suggestions/status', {}), env),
				await adminSuggestionsRoute(post('/admin/suggestions/delete', {}), env),
				await adminSuggestionsRoute(get('/admin/suggestions.csv'), env),
				await adminSuggestionsRoute(get('/admin/suggestions.csv', cookie), env),
				await adminSuggestionsRoute(new Request('https://news.dev.pr/admin/suggestions/status', { method: 'PUT' }), env),
				await adminSuggestionsRoute(post('/admin/signin', { email: 'not-an-email', 'cf-turnstile-response': 'valid-token' }), env),
			];
			for (const response of responses) {
				expect(response).toBeTruthy();
				expect(response?.headers.get('Cache-Control')).toBe('no-store');
				expect(response?.headers.get('Referrer-Policy')).toBe('no-referrer');
				expect(response?.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
				expect(response?.headers.get('X-Content-Type-Options')).toBe('nosniff');
				const csp = response?.headers.get('Content-Security-Policy') ?? '';
				expect(csp).toContain("default-src 'none'");
				expect(csp).toContain("frame-ancestors 'none'");
				expect(csp).toContain("base-uri 'none'");
				expect(csp).not.toContain("script-src 'unsafe-inline'");
				if ((response?.headers.get('Content-Type') ?? '').includes('text/html')) {
					const html = await response!.text();
					expect(html).not.toContain('cloudflareinsights');
					expect(html).not.toContain('beacon.min.js');
				}
			}
		} finally { mock.restore(); }
	});

	it('pauses sign-in truthfully when Turnstile or mail is not configured and keeps headers', async () => {
		const { DB, db } = database();
		const env = { ...baseEnv(DB), TURNSTILE_SITE_KEY: undefined } as unknown as SuggestionEnv;
		const mock = mockFetch(() => { throw new Error('paused form must not call a provider'); });
		try {
			const page = await adminSuggestionsRoute(get('/admin?lang=en'), env);
			expect(page?.status).toBe(200);
			const html = await page!.text();
			expect(html).toContain('temporarily paused');
			expect(html).not.toContain('<form method="post" action="/admin/signin');
			expect(page?.headers.get('Cache-Control')).toBe('no-store');

			const submit = await adminSuggestionsRoute(post('/admin/signin?lang=en', {
				email: ADMIN_EMAIL, 'cf-turnstile-response': 'valid-token',
			}), env);
			expect(submit?.status).toBe(503);
			expect(await submit?.text()).toContain('temporarily unavailable');
			expect(count(db, 'admin_tokens')).toBe(0);
			expect(mock.calls).toHaveLength(0);
		} finally { mock.restore(); }
	});

	it('returns the identical 202 response for owner and non-owner addresses', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			resetPace(db);
			const owner = await adminSuggestionsRoute(post('/admin/signin?lang=es', {
				email: ADMIN_EMAIL, lang: 'es', 'cf-turnstile-response': 'valid-token',
			}), env);
			const other = await adminSuggestionsRoute(post('/admin/signin?lang=es', {
				email: 'reader@example.org', lang: 'es', 'cf-turnstile-response': 'valid-token',
			}), env);
			expect(owner?.status).toBe(202);
			expect(other?.status).toBe(202);
			expect(await owner!.text()).toBe(await other!.text());
			expect(sends(mock)).toHaveLength(1);
		} finally { mock.restore(); }
	});

	it('links to /admin from neither / nor /fuentes, and serves HEAD without a body', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const data = { items: [], translations: {}, feeds: [] };
		for (const path of ['/?lang=es', '/?lang=en', '/fuentes?lang=es', '/fuentes?lang=en']) {
			const html = await renderer.fetch(get(path), data).text();
			expect(html).not.toContain('/admin');
			expect(html).not.toContain('Panel de administración');
			expect(html).not.toContain('Admin dashboard');
		}
		const head = await adminSuggestionsRoute(new Request('https://news.dev.pr/admin/suggestions.csv', { method: 'HEAD' }), env);
		expect(head?.status).toBe(200);
		expect(await head?.text()).toBe('');
		expect(head?.headers.get('Cache-Control')).toBe('no-store');
	});

	it('lets unrelated paths fall through and wires /admin through the Worker entrypoint before caching', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			expect(await adminSuggestionsRoute(get('/fuentes?lang=es'), env)).toBeUndefined();
			expect(await adminSuggestionsRoute(get('/administer'), env)).toBeUndefined();
			const worker = (await import('../src/index')).default;
			const response = await worker.fetch(get('/admin?lang=en'), env as any);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain('Access restricted to the site owner');
			expect(response.headers.get('Cache-Control')).toBe('no-store');
			expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
		} finally { mock.restore(); }
	});
});

/* ================================================================== outbox & logging */

describe('outbox safety and log hygiene', () => {
	it('never leaves the raw token in a sent outbox row and scrubs it immediately', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const { token } = await signIn(env, db, mock);
			const outbox = row(db, 'SELECT payload,state,provider_ref FROM admin_outbox');
			expect(outbox.state).toBe('sent');
			expect(outbox.payload).toBe('{}');
			expect(outbox.provider_ref).toBe('mail-ref');
			expect(JSON.stringify(row(db, 'SELECT * FROM admin_outbox'))).not.toContain(token);
			// The token only ever existed in the delivered mail body.
			expect(String(sends(mock)[0].json.text)).toContain(token);
		} finally { mock.restore(); }
	});

	it('never logs raw tokens, session secrets or email addresses', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const logs = () => errors.mock.calls.flat().join(' ');
		try {
			resetPace(db);
			const signin = await adminSuggestionsRoute(post('/admin/signin?lang=es', {
				email: ADMIN_EMAIL, lang: 'es', 'cf-turnstile-response': 'valid-token',
			}), env);
			expect(signin?.status).toBe(202);
			const token = tokenFromMail(mock);
			expect(logs()).not.toContain(token);
			expect(logs()).not.toContain(ADMIN_EMAIL);

			// A hostile Origin/Referer must only be logged as a classification, never echoed.
			const hostile = `https://evil.example/leak?email=${encodeURIComponent(ADMIN_EMAIL)}&token=${token}`;
			const blocked = await adminSuggestionsRoute(post('/admin/signin?lang=es', {
				email: ADMIN_EMAIL, lang: 'es', 'cf-turnstile-response': 'valid-token',
			}, { Origin: hostile, 'Sec-Fetch-Site': 'cross-site' }), env);
			expect(blocked?.status).toBe(403);
			expect(logs()).not.toContain('evil.example');
			expect(logs()).not.toContain(token);
			expect(logs()).not.toContain(ADMIN_EMAIL);

			const redeem = await adminSuggestionsRoute(post('/admin/in?lang=es', { token, lang: 'es' }), env);
			expect(redeem?.status).toBe(303);
			const secret = setCookieOf(redeem).split('=')[1]?.split(';')[0] ?? '';
			expect(secret).toMatch(/^[a-f0-9]{64}$/);
			expect(logs()).not.toContain(secret);

			const replay = await adminSuggestionsRoute(post('/admin/in?lang=es', { token, lang: 'es' }), env);
			expect(replay?.status).toBe(400);
			expect(logs()).not.toContain(token);
			expect(logs()).not.toContain(secret);
			expect(logs()).not.toContain(ADMIN_EMAIL);
		} finally { mock.restore(); }
	});

	it('parks an ambiguous send as uncertain and never auto-resends it', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(call => call.url.includes('siteverify')
			? Response.json({ success: true, hostname: 'news.dev.pr', action: 'admin_signin' })
			: new Response('provider down', { status: 500 }));
		try {
			const now = Date.now() + 60000;
			const verdict = await requestAdminSignin(env, { email: ADMIN_EMAIL, captcha: 'valid-token', language: 'es' }, now);
			expect(verdict).toEqual({ ok: true, status: 'accepted' });
			expect(row(db, 'SELECT state FROM admin_outbox').state).toBe('uncertain');
			const before = sends(mock).length;
			await flushAdminOutbox(env, now + 10 * 60000);
			expect(sends(mock)).toHaveLength(before);
			expect(row(db, 'SELECT state FROM admin_outbox').state).toBe('uncertain');
			expect(row(db, 'SELECT attempts FROM admin_outbox').attempts).toBe(1);
		} finally { mock.restore(); }
	});
});

/* ================================================================== full end-to-end */

describe('end-to-end owner flow', () => {
	it('signin → GET /admin/in → POST /admin/in → dashboard → status → CSV → delete → signout', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			seedSuggestion(db, { id: 'row-e2e', name: 'E2E Noticel', status: 'pending', email: 'reader@example.org' });
			resetPace(db);

			// 1) Owner requests the magic link; the response reveals nothing.
			const signin = await adminSuggestionsRoute(post('/admin/signin?lang=es', {
				email: ADMIN_EMAIL, lang: 'es', 'cf-turnstile-response': 'valid-token',
			}), env);
			expect(signin?.status).toBe(202);
			const token = tokenFromMail(mock);
			expect(token).toMatch(/^[a-f0-9]{64}$/);
			expect(row(db, 'SELECT payload FROM admin_outbox').payload).toBe('{}');

			// 2) The mailed GET link only renders confirmation and does not consume the token.
			const confirm = await adminSuggestionsRoute(get(`/admin/in?token=${token}&lang=es`), env);
			expect(confirm?.status).toBe(200);
			expect(await confirm!.text()).toContain(`name="token" value="${token}"`);
			expect(row(db, 'SELECT used_at FROM admin_tokens').used_at).toBeNull();
			expect(count(db, 'admin_sessions')).toBe(0);

			// 3) The confirmation POST redeems the link and 303-redirects to a clean URL.
			const redeem = await adminSuggestionsRoute(post('/admin/in?lang=es', { token, lang: 'es' }), env);
			expect(redeem?.status).toBe(303);
			expect(redeem?.headers.get('Location')).toBe('/admin/suggestions?lang=es');
			const cookie = cookiePair(setCookieOf(redeem));
			expect(cookie).toMatch(new RegExp(`^${ADMIN_COOKIE}=[a-f0-9]{64}$`));

			// 4) The dashboard shows the session owner and the pending suggestion.
			const dashboard = await adminSuggestionsRoute(get('/admin/suggestions?lang=es', { Cookie: cookie }), env);
			expect(dashboard?.status).toBe(200);
			const html = await dashboard!.text();
			expect(html).toContain(ADMIN_EMAIL);
			expect(html).toContain('E2E Noticel');
			const csrf = csrfOf(html);
			expect(csrf).toMatch(/^[a-f0-9]{64}$/);

			// 5) Mark reviewed with a note; the filtered view is restored.
			const status = await adminSuggestionsRoute(post('/admin/suggestions/status?lang=es', {
				csrf, id: 'row-e2e', status: 'reviewed', admin_note: 'Looks good\nLine 2', lang: 'es',
				returnStatus: 'pending',
			}, { Cookie: cookie }), env);
			expect(status?.status).toBe(303);
			expect(status?.headers.get('Location')).toBe('/admin/suggestions?lang=es&status=pending');
			expect(row(db, "SELECT status,admin_note FROM source_suggestions WHERE id='row-e2e'"))
				.toEqual({ status: 'reviewed', admin_note: 'Looks good\nLine 2' });

			// 6) The CSV export is session-gated and spreadsheet-safe.
			const csv = await adminSuggestionsRoute(get('/admin/suggestions.csv?lang=es', { Cookie: cookie }), env);
			expect(csv?.status).toBe(200);
			expect(csv?.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
			const csvText = await csv!.text();
			expect(csvText.split('\n')[0]).toBe('kind,name,target,notes,email,language,status,admin_note,created_at,confirmed_at');
			expect(csvText).toContain('E2E Noticel,https://www.noticel.com/');
			expect(csvText).toContain('reviewed');
			expect(csvText).toContain('"Looks good\nLine 2"');

			// 7) Delete removes exactly the targeted row.
			const deleted = await adminSuggestionsRoute(post('/admin/suggestions/delete?lang=es', {
				csrf, id: 'row-e2e', lang: 'es',
			}, { Cookie: cookie }), env);
			expect(deleted?.status).toBe(303);
			expect(deleted?.headers.get('Location')).toBe('/admin/suggestions?lang=es');
			expect(count(db, 'source_suggestions')).toBe(0);

			// 8) Sign out revokes the session server-side and clears the /admin cookie.
			const signout = await adminSuggestionsRoute(post('/admin/signout?lang=es', { csrf, lang: 'es' }, { Cookie: cookie }), env);
			expect(signout?.status).toBe(303);
			expect(signout?.headers.get('Location')).toBe('/admin');
			expect(setCookieOf(signout)).toContain('Max-Age=0');
			expect(count(db, 'admin_sessions')).toBe(0);

			const afterwards = await adminSuggestionsRoute(get('/admin/suggestions?lang=es', { Cookie: cookie }), env);
			expect(afterwards?.status).toBe(200);
			expect(await afterwards!.text()).toContain('Acceso restringido al propietario');
			expect(mock.calls.filter(c => c.url.includes('siteverify'))).toHaveLength(1);
			expect(sends(mock)).toHaveLength(1);
		} finally { mock.restore(); }
	});
});
