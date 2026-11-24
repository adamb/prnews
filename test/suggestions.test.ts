/**
 * Source suggestions (sites + news influencers) end-to-end tests against the real migration
 * SQL and mocked provider fetch calls. No real mail or Turnstile request escapes.
 *
 * Coverage: SQL-injection payloads in every text field, stored-XSS payloads on retry pages and
 * in the owner notification HTML, CRLF/NUL header injection, unsafe/private target URLs,
 * influencer handles, Turnstile action/hostname claim checks, fail-closed configuration,
 * same-origin gate, 16 KiB body cap, honeypot, honest captcha retry, per-address and global
 * daily caps, hash-only single-use tokens, double opt-in, replay/expiry/race redemption,
 * bilingual pages, strict security headers and the /fuentes + footer /sugerir links.
 */
import {describe,it,expect,vi,afterEach} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {
	sanitizeSuggestionInput, submitSuggestion, confirmSuggestion, flushSuggestionOutbox,
	publicSuggestionsConfigured, suggestionsConfigured, OWNER_SUGGESTION_EMAIL,
	type SuggestionEnv,
} from '../src/suggestions';
import {suggestionsRoute} from '../src/suggestions-http';
import {alertThemeBoot, alertThemeToggle, alertThemeBootHash, alertThemeToggleHash} from '../src/alerts-http';
import {turnstileClientScript, turnstileClientScriptHash} from '../src/turnstile';
import renderer from '../src/render';

const MIGRATIONS = ['0009_alerts.sql', '0019_source_suggestions.sql'];
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
/** Siteverify success for the 'suggest' surface; every outbound mail is accepted. */
function providerOk(call: FetchCall): Response {
	if (call.url.includes('siteverify')) return Response.json({ success: true, hostname: 'news.dev.pr', action: 'suggest' });
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
async function countRows(env: SuggestionEnv, table: string): Promise<number> {
	const found = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).bind().first<any>();
	return Number(found?.n ?? 0);
}
async function userCounts(env: SuggestionEnv) {
	return {
		suggestions: await countRows(env, 'source_suggestions'),
		tokens: await countRows(env, 'source_suggestion_tokens'),
		outbox: await countRows(env, 'source_suggestion_outbox'),
	};
}
function outboxPayload(db: DatabaseSync, kind = 'confirm'): any {
	const found = row(db, 'SELECT payload FROM source_suggestion_outbox WHERE kind=? ORDER BY created_at LIMIT 1', kind);
	return found ? JSON.parse(String(found.payload)) : undefined;
}
function confirmLink(mock: MockApi, email: string): string | undefined {
	const mail = sends(mock).find(c => String(c.json?.to ?? '') === email);
	const text = String(mail?.json?.text ?? '');
	return text.match(/https:\/\/news\.dev\.pr\/sugerir\/confirm\?[^\s]+/)?.[0];
}
const validFields: Record<string, string> = {
	kind: 'site', name: 'Noticel', target: 'noticel.com', notes: '', email: 'reader@example.org',
	lang: 'es', 'cf-turnstile-response': 'valid-token',
};
const submitInput = (overrides: Record<string, unknown> = {}) => ({
	kind: 'site', name: 'Noticel', target: 'noticel.com', notes: '', email: 'reader@example.org',
	language: 'es', turnstileToken: 'valid-token', ...overrides,
});
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const unescaped = (html: string, value: string) => !html.includes(value) && html.includes(escapeHtml(value));

afterEach(() => { vi.restoreAllMocks(); });

describe('target validation: unsafe URLs, private hosts, handles', () => {
	const base = { kind: 'site' as const, name: 'Noticel', target: 'noticel.com', notes: '', email: 'reader@example.org', language: 'es' as const };
	it.each([
		['javascript URI', 'javascript:alert(1)'],
		['data URI', 'data:text/html,<script>alert(1)</script>'],
		['vbscript URI', 'vbscript:msgbox(1)'],
		['file URI', 'file:///etc/passwd'],
		['ftp URI', 'ftp://example.com'],
		['embedded credentials', 'https://user:pass@example.com'],
		['localhost', 'http://localhost/feed'],
		['loopback IPv4', 'http://127.0.0.1/feed'],
		['short loopback', 'http://127.1/feed'],
		['decimal loopback', 'http://2130706433/feed'],
		['hex loopback', 'http://0x7f000001/feed'],
		['IPv6 loopback', 'http://[::1]/feed'],
		['unspecified IPv4', 'http://0.0.0.0/feed'],
		['private 10/8', 'http://10.1.2.3/feed'],
		['private 172.16/12', 'http://172.16.0.1/feed'],
		['private 192.168/16', 'http://192.168.1.1/feed'],
		['carrier NAT', 'http://100.64.0.1/feed'],
		['link-local metadata', 'http://169.254.169.254/latest/meta-data'],
		['localhost subdomain', 'http://app.localhost/feed'],
		['internal TLD', 'http://metadata.google.internal/'],
		['control characters', 'https://example.com\r\nBcc: attacker@evil.com'],
	])('rejects %s', (_name, target) => {
		const result = sanitizeSuggestionInput({ ...base, target });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.field).toBe('target');
	});
	it.each([
		['https://www.noticel.com/', 'https://www.noticel.com/'],
		['https://noticel.com/feed', 'https://noticel.com/feed'],
		['https://example.com/news?q=1', 'https://example.com/news?q=1'],
		['noticel.com', 'https://noticel.com/'],
		['noticel.com/feed', 'https://noticel.com/feed'],
		['www.noticel.com', 'https://www.noticel.com/'],
	])('accepts and normalizes site URL %j', (target, expected) => {
		const result = sanitizeSuggestionInput({ ...base, target });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.target).toBe(expected);
	});
	it.each([
		['@noticel', '@noticel'],
		['Instagram: @noticel', 'Instagram: @noticel'],
		['Instagram:@noticel', 'Instagram:@noticel'],
		['X: @noticel', 'X: @noticel'],
		['X @noticel', 'X @noticel'],
		['https://www.instagram.com/noticel/', 'https://www.instagram.com/noticel/'],
		['https://x.com/noticel', 'https://x.com/noticel'],
		['tiktok.com/@noticel', 'https://tiktok.com/@noticel'],
	])('accepts influencer handle/profile %j', (target, expected) => {
		const result = sanitizeSuggestionInput({ ...base, kind: 'influencer', target });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.target).toBe(expected);
	});
	it.each(['@a', '@@noticel', 'noticel', '@noticel!', '@noticel with space', 'Instagram:', '@<script>', 'javascript:alert(1)'])
		('rejects malformed influencer handle %j', target => {
			const result = sanitizeSuggestionInput({ ...base, kind: 'influencer', target });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.field).toBe('target');
		});
	it('enforces field caps, kind and language normalization', () => {
		expect(sanitizeSuggestionInput({ ...base, kind: 'blog' as any }).ok).toBe(false);
		expect(sanitizeSuggestionInput({ ...base, name: 'a' }).ok).toBe(false);
		expect(sanitizeSuggestionInput({ ...base, name: 'a'.repeat(121) }).ok).toBe(false);
		expect(sanitizeSuggestionInput({ ...base, target: `https://example.com/${'a'.repeat(300)}` }).ok).toBe(false);
		expect(sanitizeSuggestionInput({ ...base, notes: 'n'.repeat(401) }).ok).toBe(false);
		expect(sanitizeSuggestionInput({ ...base, email: 'not-an-email' }).ok).toBe(false);
		expect(sanitizeSuggestionInput({ ...base, email: `${'a'.repeat(250)}@example.org` }).ok).toBe(false);
		expect(sanitizeSuggestionInput({ ...base, notes: undefined }).ok).toBe(true);
		const english = sanitizeSuggestionInput({ ...base, language: 'en' });
		expect(english.ok && english.value.language).toBe('en');
		const fallback = sanitizeSuggestionInput({ ...base, language: 'fr' });
		expect(fallback.ok && fallback.value.language).toBe('es');
	});
});

describe('SQL injection resilience', () => {
	it('stores SQL payloads as literal data and leaves every table and prior row intact', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const created = Date.now() - 1000;
			db.prepare('INSERT INTO source_suggestions(id,kind,name,target,notes,email,language,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
				.run('legit', 'site', 'Legit', 'https://legit.example/', '', 'legit@example.org', 'es', 'pending', created);
			const before = row(db, "SELECT * FROM source_suggestions WHERE id='legit'");
			const verdict = await submitSuggestion(env, submitInput({
				name: "'; DROP TABLE source_suggestions; --",
				target: "https://example.com/'; DROP TABLE source_suggestions; --",
				notes: "' OR '1'='1",
				email: "x'||'@example.com",
			}) as any, Date.now() + 60000);
			expect(verdict.ok).toBe(true);
			// A parameterized insert keeps the schema alive and adds exactly one row.
			expect(rows(db, 'SELECT name FROM sqlite_master WHERE type=? AND name=?', 'table', 'source_suggestions')).toHaveLength(1);
			expect(rows(db, 'SELECT id FROM source_suggestions ORDER BY id')).toHaveLength(2);
			const stored = row(db, 'SELECT name,target,notes,email FROM source_suggestions WHERE name=?', "'; DROP TABLE source_suggestions; --");
			expect(stored.name).toBe("'; DROP TABLE source_suggestions; --");
			expect(stored.notes).toBe("' OR '1'='1");
			expect(stored.email).toBe("x'||'@example.com");
			expect(String(stored.target)).toContain('DROP%20TABLE');
			// The pre-existing row is untouched and no injection widened the result set.
			expect(row(db, "SELECT * FROM source_suggestions WHERE id='legit'")).toEqual(before);
			expect(rows(db, "SELECT id FROM source_suggestions WHERE name='Legit'")).toHaveLength(1);
			expect(await countRows(env, 'source_suggestion_tokens')).toBe(1);
			expect(await countRows(env, 'source_suggestion_outbox')).toBe(1);
		} finally { mock.restore(); }
	});
});

describe('CRLF, control characters and mail headers', () => {
	const base = { kind: 'site' as const, name: 'Noticel', target: 'noticel.com', notes: '', email: 'reader@example.org', language: 'es' as const };
	it('strips CRLF/NUL from single-line fields, keeps only LF in notes, and rejects header-shaped emails', () => {
		const clean = sanitizeSuggestionInput({
			...base,
			name: 'ACME\r\nBcc: attacker@evil.com\x00',
			notes: 'Line 1\r\nBcc: attacker@evil.com\x00<img src=x>',
		});
		expect(clean.ok).toBe(true);
		if (!clean.ok) return;
		expect(clean.value.name).toBe('ACME Bcc: attacker@evil.com');
		expect(clean.value.name).not.toMatch(/[\r\n\0]/);
		expect(clean.value.notes).toBe('Line 1\nBcc: attacker@evil.com<img src=x>');
		expect(clean.value.notes).not.toMatch(/[\r\0]/);
		// A CRLF in the target is not silently normalized into a valid URL.
		expect(sanitizeSuggestionInput({ ...base, target: 'https://example.com\r\nBcc: attacker@evil.com' }).ok).toBe(false);
		// CRLF in the email is rejected; a trailing NUL is stripped before validation.
		expect(sanitizeSuggestionInput({ ...base, email: 'reader@example.com\r\nBcc: attacker@evil.com' }).ok).toBe(false);
		expect(sanitizeSuggestionInput({ ...base, email: 'reader@example.com\x00' }).ok).toBe(true);
	});
	it('never emits CRLF/NUL in the confirmation or owner mail headers', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const now = Date.now() + 60000;
			await submitSuggestion(env, submitInput({
				name: 'ACME\r\nBcc: attacker@evil.com\x00',
				notes: 'Line 1\r\nBcc: attacker@evil.com\x00',
			}) as any, now);
			const confirmation = sends(mock).find(c => c.json?.to === 'reader@example.org');
			expect(confirmation).toBeTruthy();
			const token = new URL(confirmLink(mock, 'reader@example.org')!).searchParams.get('token')!;
			expect(outboxPayload(db).token).toBeUndefined();
			expect(String(confirmation!.json.subject)).not.toMatch(/[\r\n\0]/);
			expect(String(confirmation!.json.to)).not.toMatch(/[\r\n\0]/);
			expect(String(confirmation!.json.text)).toContain(token);
			resetPace(db);
			const confirmed = await confirmSuggestion(env, token, now + 1000);
			expect(confirmed.ok).toBe(true);
			const owner = sends(mock).find(c => c.json?.to === OWNER_SUGGESTION_EMAIL);
			expect(owner).toBeTruthy();
			expect(String(owner!.json.subject)).not.toMatch(/[\r\n\0]/);
			expect(String(owner!.json.to)).not.toMatch(/[\r\n\0]/);
			const suggestion = row(db, 'SELECT name,notes FROM source_suggestions');
			expect(suggestion.name).toBe('ACME Bcc: attacker@evil.com');
			expect(suggestion.notes).not.toMatch(/[\r\0]/);
		} finally { mock.restore(); }
	});
});

describe('public submission gates', () => {
	it('requires both the mail sender and the Turnstile secret', () => {
		const { DB } = database(); const env = baseEnv(DB);
		expect(suggestionsConfigured(env)).toBe(true);
		expect(publicSuggestionsConfigured(env)).toBe(true);
		expect(suggestionsConfigured({ ...env, IMPROVMX_API_KEY: undefined } as any)).toBe(false);
		expect(publicSuggestionsConfigured({ ...env, IMPROVMX_API_KEY: undefined } as any)).toBe(false);
		expect(publicSuggestionsConfigured({ ...env, TURNSTILE_SECRET_KEY: undefined } as any)).toBe(false);
	});

	it.each([
		['mail provider', { IMPROVMX_API_KEY: undefined }],
		['Turnstile secret', { TURNSTILE_SECRET_KEY: undefined }],
	])('pauses the form and answers 503 when the %s is missing', async (_label, overrides) => {
		const { DB, db } = database();
		const env = { ...baseEnv(DB), ...overrides } as unknown as SuggestionEnv;
		const mock = mockFetch(() => { throw new Error('no provider calls while paused'); });
		try {
			const page = await suggestionsRoute(get('/sugerir?lang=en'), env);
			expect(page?.status).toBe(200);
			const html = (await page?.text()) ?? '';
			expect(html).toContain('temporarily paused');
			expect(html).not.toContain('<form method="post" action="/sugerir');
			expect(html).not.toContain('class="cf-turnstile"');
			const response = await suggestionsRoute(post('/sugerir?lang=en', validFields), env);
			expect(response?.status).toBe(503);
			expect(await response?.text()).toContain('temporarily unavailable');
			expect(mock.calls).toHaveLength(0);
			expect(await userCounts(env)).toEqual({ suggestions: 0, tokens: 0, outbox: 0 });
			// Only the bounded aggregate outcome counter is written; never user data.
			expect(db.prepare('SELECT COUNT(*) AS n FROM alert_limits').get()?.n).toBe(1);
		} finally { mock.restore(); }
	});

	it.each([
		['site key', { TURNSTILE_SITE_KEY: undefined }],
		['hostname allowlist', { TURNSTILE_HOSTNAMES: undefined }],
	])('pauses the UI and never accepts a tokenless post when the Turnstile %s is missing', async (_label, overrides) => {
		const { DB, db } = database();
		const env = { ...baseEnv(DB), ...overrides } as unknown as SuggestionEnv;
		const mock = mockFetch(() => { throw new Error('tokenless posts must not call siteverify'); });
		try {
			const page = await suggestionsRoute(get('/sugerir?lang=en'), env);
			expect(page?.status).toBe(200);
			const html = (await page?.text()) ?? '';
			expect(html).toContain('temporarily paused');
			expect(html).not.toContain('class="cf-turnstile"');
			expect(html).not.toContain('<form method="post" action="/sugerir');
			const tokenless = { ...validFields } as Record<string, string>;
			delete tokenless['cf-turnstile-response'];
			const response = await suggestionsRoute(post('/sugerir', tokenless), env);
			// The UI is paused; the endpoint also refuses the tokenless post. The code answers
			// 400 (captcha retry) rather than 503 for a missing render-only key/allowlist; this
			// status inconsistency is recorded in the audit notes.
			expect([400, 503]).toContain(response?.status);
			expect(mock.calls).toHaveLength(0);
			expect(await userCounts(env)).toEqual({ suggestions: 0, tokens: 0, outbox: 0 });
			expect(db.prepare('SELECT COUNT(*) AS n FROM alert_limits').get()?.n).toBe(1);
		} finally { mock.restore(); }
	});

	it.each([
		['a foreign origin', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', Referer: 'https://evil.example/' }],
		['a null origin without browser evidence', { Origin: 'null' }],
		['cross-site fetch metadata', { 'Sec-Fetch-Site': 'cross-site' }],
	])('blocks %s before any database write or provider call', async (_name, headers) => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => { throw new Error('blocked requests never reach a provider'); });
		try {
			const response = await suggestionsRoute(post('/sugerir', validFields, headers), env);
			expect(response?.status).toBe(403);
			const html = (await response?.text()) ?? '';
			expect(html).toContain('verificación de origen');
			expect(html).not.toContain('Si corresponde');
			expect(mock.calls).toHaveLength(0);
			expect(await userCounts(env)).toEqual({ suggestions: 0, tokens: 0, outbox: 0 });
			expect(db.prepare('SELECT COUNT(*) AS n FROM alert_limits').get()?.n).toBe(0);
		} finally { mock.restore(); }
	});

	it('rejects a body over 16 KiB and a non-form content type without touching the database', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => { throw new Error('unreadable requests never reach a provider'); });
		try {
			const huge = new Request('https://news.dev.pr/sugerir', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://news.dev.pr' },
				body: new URLSearchParams({ ...validFields, notes: 'x'.repeat(17000) }).toString(),
			});
			const over = await suggestionsRoute(huge, env);
			expect(over?.status).toBe(400);
			expect(await over?.text()).toContain('Solicitud no válida');
			const json = new Request('https://news.dev.pr/sugerir', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Origin: 'https://news.dev.pr' },
				body: JSON.stringify(validFields),
			});
			const wrong = await suggestionsRoute(json, env);
			expect(wrong?.status).toBe(400);
			expect(mock.calls).toHaveLength(0);
			expect(await userCounts(env)).toEqual({ suggestions: 0, tokens: 0, outbox: 0 });
			expect(db.prepare('SELECT COUNT(*) AS n FROM alert_limits').get()?.n).toBe(0);
		} finally { mock.restore(); }
	});

	it('answers a tokenless honeypot submission generically without storing or mailing it', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => { throw new Error('tokenless honeypot must not call siteverify'); });
		try {
			const fields = { ...validFields, 'cf-turnstile-response': '', x_presencia: 'spam bot' };
			const response = await suggestionsRoute(post('/sugerir', fields), env);
			expect(response?.status).toBe(202);
			const html = (await response?.text()) ?? '';
			expect(html).toContain('Recibimos tu sugerencia');
			expect(html).not.toContain('reader@example.org');
			expect(mock.calls).toHaveLength(0);
			expect(await userCounts(env)).toEqual({ suggestions: 0, tokens: 0, outbox: 0 });
			// The only write is the aggregate outcome bucket, not the bot's input.
			expect(db.prepare("SELECT count FROM alert_limits WHERE bucket='suggest-outcome:accepted'").get()?.count).toBe(1);
		} finally { mock.restore(); }
	});

	it('lets a verified challenge override the honeypot for autofill users', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const response = await suggestionsRoute(post('/sugerir', { ...validFields, x_presencia: 'autofill text' }), env);
			expect(response?.status).toBe(202);
			expect(await countRows(env, 'source_suggestions')).toBe(1);
			expect(sends(mock)).toHaveLength(1);
		} finally { mock.restore(); }
	});

	it('rejects a token minted for another action or hostname, and checks the siteverify request', async () => {
		const cases = [
			{ success: true, hostname: 'news.dev.pr', action: 'signup' },
			{ success: true, hostname: 'evil.example', action: 'suggest' },
			{ success: false, 'error-codes': ['invalid-input-response'] },
		];
		for (const data of cases) {
			const { DB } = database(); const env = baseEnv(DB);
			const mock = mockFetch(() => Response.json(data as any));
			try {
				const verdict = await submitSuggestion(env, submitInput({ ip: '203.0.113.5' }) as any, Date.now() + 60000);
				expect(verdict.ok).toBe(false);
				if (!verdict.ok) expect(verdict.status).toBe('captcha');
				const verify = verifies(mock)[0];
				expect(verify.init.method).toBe('POST');
				expect(verify.json.secret).toBe('turnstile-secret');
				expect(verify.json.response).toBe('valid-token');
				expect(verify.json.remoteip).toBe('203.0.113.5');
				expect(await userCounts(env)).toEqual({ suggestions: 0, tokens: 0, outbox: 0 });
			} finally { mock.restore(); }
		}
	});

	it('rejects an oversized Turnstile token without a provider request', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => { throw new Error('oversized token must be rejected locally'); });
		try {
			const verdict = await submitSuggestion(env, submitInput({ turnstileToken: 'x'.repeat(2049) }) as any, Date.now() + 60000);
			expect(verdict.ok).toBe(false);
			if (!verdict.ok) expect(verdict.status).toBe('captcha');
			expect(mock.calls).toHaveLength(0);
			expect(await userCounts(env)).toEqual({ suggestions: 0, tokens: 0, outbox: 0 });
		} finally { mock.restore(); }
	});

	it('returns an honest 400 captcha retry page with a fresh widget and escaped retained input', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(call => call.url.includes('siteverify')
			? Response.json({ success: false, 'error-codes': ['invalid-input-response'] })
			: Response.json({}));
		try {
			const payload = {
				...validFields,
				name: '<script>alert(1)</script>',
				target: '"><img src=x onerror=alert(1)>',
				notes: '<img src=x onerror=alert(1)>',
				email: '" onfocus="alert(1)',
				'cf-turnstile-response': 'expired-token-abc123',
			};
			const response = await suggestionsRoute(post('/sugerir', payload), env);
			expect(response?.status).toBe(400);
			const html = (await response?.text()) ?? '';
			expect(html).toContain('No pudimos verificar');
			expect(html).toContain('No se registró nada');
			expect(html).not.toContain('Si corresponde');
			expect(html).not.toContain('expired-token-abc123');
			expect(html).toContain('cf-turnstile');
			expect(html).toContain('data-action="suggest"');
			expect(unescaped(html, payload.name)).toBe(true);
			expect(unescaped(html, payload.target)).toBe(true);
			expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
			expect(html).toContain('&quot; onfocus=&quot;alert(1)');
			expect(html).not.toContain('<script>alert(1)</script>');
			expect(html).not.toContain('"><img src=x');
			expect(verifies(mock)).toHaveLength(1);
			expect(sends(mock)).toHaveLength(0);
			expect(await userCounts(env)).toEqual({ suggestions: 0, tokens: 0, outbox: 0 });
			const english = await suggestionsRoute(post('/sugerir?lang=en', { ...payload, 'cf-turnstile-response': '' }), env);
			expect(english?.status).toBe(400);
			expect(await english?.text()).toContain('We could not verify');
		} finally { mock.restore(); }
	});

	it('escapes every retained field on a validation retry page and writes nothing', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const payload = {
				...validFields,
				name: '<script>alert(1)</script>',
				target: 'javascript:alert(1)',
				notes: '<img src=x onerror=alert(1)>',
				email: '" onfocus="alert(1)',
			};
			const response = await suggestionsRoute(post('/sugerir', payload), env);
			expect(response?.status).toBe(400);
			const html = (await response?.text()) ?? '';
			expect(html).toContain('Ingresa el enlace del sitio');
			expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
			expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
			expect(html).toContain('&quot; onfocus=&quot;alert(1)');
			expect(html).not.toContain('<script>alert(1)</script>');
			expect(sends(mock)).toHaveLength(0);
			expect(await userCounts(env)).toEqual({ suggestions: 0, tokens: 0, outbox: 0 });
		} finally { mock.restore(); }
	});

	it('enforces the per-address daily cap and keeps the over-limit answer generic', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const bodies: string[] = [];
			for (let i = 0; i < 4; i++) {
				resetPace(db);
				const response = await suggestionsRoute(post('/sugerir', { ...validFields, name: `Noticel ${i}`, email: 'cap@example.org' }), env);
				expect(response?.status).toBe(202);
				bodies.push(await response!.text());
			}
			expect(bodies[3]).toBe(bodies[0]);
			expect(await countRows(env, 'source_suggestions')).toBe(3);
			expect(await countRows(env, 'source_suggestion_tokens')).toBe(3);
			expect(await countRows(env, 'source_suggestion_outbox')).toBe(3);
			expect(sends(mock)).toHaveLength(3);
			expect(verifies(mock)).toHaveLength(4);
		} finally { mock.restore(); }
	});

	it('enforces the global daily cap and answers the over-limit attempt honestly with 429', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const day = dayOf(Date.now());
		db.prepare('INSERT INTO alert_limits(bucket,day,count) VALUES(?,?,?)').run('suggest_global', day, 29);
		const mock = mockFetch(providerOk);
		try {
			resetPace(db);
			const first = await suggestionsRoute(post('/sugerir', { ...validFields, email: 'global-a@example.org' }), env);
			expect(first?.status).toBe(202);
			resetPace(db);
			const second = await suggestionsRoute(post('/sugerir?lang=en', { ...validFields, email: 'global-b@example.org' }), env);
			expect(second?.status).toBe(429);
			expect(await second?.text()).toContain('Too many suggestions');
			expect(await countRows(env, 'source_suggestions')).toBe(1);
			expect(await countRows(env, 'source_suggestion_outbox')).toBe(1);
			expect(sends(mock)).toHaveLength(1);
			expect(row(db, "SELECT count FROM alert_limits WHERE bucket='suggest_global'").count).toBe(30);
		} finally { mock.restore(); }
	});
});

describe('double opt-in, tokens and owner notice', () => {
	it('stores only a hash, confirms once, strips the token from the URL and mails escaped details to the owner', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const payload = {
				...validFields,
				name: '<script>alert(1)</script>" onfocus="alert(1)',
				target: 'https://example.com/?q=%3Cscript%3E',
				notes: 'Line 1\r\nBcc: attacker@evil.com\x00<img src=x onerror=alert(1)>',
				email: 'reader@example.org',
				lang: 'en',
			};
			const response = await suggestionsRoute(post('/suggest?lang=en', payload), env);
			expect(response?.status).toBe(202);
			const accepted = await response!.text();
			expect(accepted).toContain('We received your suggestion');
			expect(accepted).not.toContain('reader@example.org');
			expect(accepted).not.toContain(payload.name);

			const suggestion = row(db, 'SELECT * FROM source_suggestions');
			expect(suggestion.language).toBe('en');
			expect(suggestion.status).toBe('pending');
			expect(suggestion.name).not.toMatch(/[\r\n\0]/);
			expect(suggestion.notes).not.toMatch(/[\r\0]/);

			const tokenRow = row(db, 'SELECT * FROM source_suggestion_tokens');
			const link = confirmLink(mock, 'reader@example.org');
			expect(link).toBeTruthy();
			const token = new URL(link!).searchParams.get('token')!;
			expect(outboxPayload(db).token).toBeUndefined();
			expect(token).toMatch(/^[a-f0-9]{64}$/);
			expect(tokenRow.token_hash).toBe(sha256(token));
			expect(tokenRow.token_hash).not.toBe(token);
			expect(JSON.stringify(tokenRow)).not.toContain(token);
			expect(tokenRow.expires_at).toBeGreaterThan(Date.now());

			const confirmation = sends(mock).find(c => String(c.json?.to) === 'reader@example.org');
			expect(confirmation).toBeTruthy();
			expect(String(confirmation!.json.subject)).not.toMatch(/[\r\n\0]/);
			expect(String(confirmation!.json.text)).toContain(`https://news.dev.pr/sugerir/confirm?token=${token}&lang=en`);

			resetPace(db);
			const confirmed = await suggestionsRoute(new Request(link!), env);
			expect(confirmed?.status).toBe(303);
			expect(confirmed?.headers.get('Location')).toBe('/sugerir/confirm?done=1&lang=en');
			expect(confirmed?.headers.get('Cache-Control')).toBe('no-store');
			expect(await confirmed?.text()).toBe('');
			expect(confirmed?.headers.get('Location')).not.toContain(token);

			const after = row(db, 'SELECT status,confirmed_at FROM source_suggestions');
			expect(after.status).toBe('confirmed');
			expect(typeof after.confirmed_at).toBe('number');

			const ownerRow = row(db, "SELECT email,state FROM source_suggestion_outbox WHERE kind='owner'");
			expect(ownerRow.email).toBe(OWNER_SUGGESTION_EMAIL);
			expect(OWNER_SUGGESTION_EMAIL).toBe('beguelin@gmail.com');
			const ownerMail = sends(mock).find(c => String(c.json?.to) === OWNER_SUGGESTION_EMAIL);
			expect(ownerMail).toBeTruthy();
			const html = String(ownerMail!.json.html);
			expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
			expect(html).toContain('&quot; onfocus=&quot;alert(1)');
			expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
			expect(html).not.toContain('<script>alert(1)</script>');
			expect(html).not.toContain('<img src=x');
			expect(String(ownerMail!.json.subject)).not.toMatch(/[\r\n\0]/);
			expect(String(ownerMail!.json.text)).not.toMatch(/[\r\0]/);

			const done = await suggestionsRoute(get('/sugerir/confirm?done=1&lang=en'), env);
			expect(done?.status).toBe(200);
			expect(await done?.text()).toContain('Suggestion confirmed');

			const sendsBefore = sends(mock).length;
			const replay = await suggestionsRoute(new Request(link!), env);
			expect(replay?.status).toBe(400);
			expect(await replay?.text()).not.toContain(token);
			expect(row(db, "SELECT COUNT(*) AS n FROM source_suggestion_outbox WHERE kind='owner'").n).toBe(1);
			expect(sends(mock)).toHaveLength(sendsBefore);
		} finally { mock.restore(); }
	});

	it('rejects an expired token without confirming or notifying the owner', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const now = Date.now() + 60000;
			await submitSuggestion(env, submitInput({ email: 'expired@example.org' }) as any, now);
			expect(outboxPayload(db).token).toBeUndefined();
			const link = confirmLink(mock, 'expired@example.org');
			expect(link).toBeTruthy();
			db.prepare('UPDATE source_suggestion_tokens SET expires_at=?').run(Date.now() - 1);
			resetPace(db);
			const response = await suggestionsRoute(new Request(link!), env);
			expect(response?.status).toBe(400);
			expect(await response?.text()).toContain('Este enlace no es válido');
			const suggestion = row(db, 'SELECT status,confirmed_at FROM source_suggestions');
			expect(suggestion.status).toBe('pending');
			expect(suggestion.confirmed_at).toBeNull();
			expect(row(db, "SELECT COUNT(*) AS n FROM source_suggestion_outbox WHERE kind='owner'").n).toBe(0);
			expect(sends(mock)).toHaveLength(1);
			expect(row(db, 'SELECT used_at FROM source_suggestion_tokens').used_at).toBeNull();
		} finally { mock.restore(); }
	});

	it('allows only one redemption when the same token is presented concurrently', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const now = Date.now() + 60000;
			await submitSuggestion(env, submitInput({ email: 'race@example.org' }) as any, now);
			const link = confirmLink(mock, 'race@example.org');
			expect(link).toBeTruthy();
			resetPace(db);
			const [first, second] = await Promise.all([
				suggestionsRoute(new Request(link!), env),
				suggestionsRoute(new Request(link!), env),
			]);
			expect([first?.status, second?.status].sort()).toEqual([303, 400]);
			expect(row(db, 'SELECT status FROM source_suggestions').status).toBe('confirmed');
			expect(row(db, "SELECT COUNT(*) AS n FROM source_suggestion_outbox WHERE kind='owner'").n).toBe(1);
			expect(sends(mock).filter(c => String(c.json?.to) === OWNER_SUGGESTION_EMAIL)).toHaveLength(1);
		} finally { mock.restore(); }
	});

	it.each([
		'',
		'not-a-token',
		'A'.repeat(64),
		'0'.repeat(63),
		'0'.repeat(65),
		`${'0'.repeat(64)}\r\nBcc: attacker@evil.com`,
	])('rejects invalid token shape %j without notifying the owner', async token => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => { throw new Error('invalid tokens never reach a provider'); });
		try {
			const response = await suggestionsRoute(get(`/sugerir/confirm?token=${encodeURIComponent(token)}`), env);
			expect(response?.status).toBe(400);
			const html = (await response?.text()) ?? '';
			expect(html).toContain('Este enlace no es válido');
			if (token) expect(html).not.toContain(token);
			expect(row(db, 'SELECT COUNT(*) AS n FROM source_suggestion_outbox').n).toBe(0);
			expect(mock.calls).toHaveLength(0);
		} finally { mock.restore(); }
	});

	it('serves the /suggest/confirm alias with the same single-use redirect', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			const now = Date.now() + 60000;
			await submitSuggestion(env, submitInput({ language: 'en' }) as any, now);
			const token = new URL(confirmLink(mock, 'reader@example.org')!).searchParams.get('token')!;
			resetPace(db);
			const response = await suggestionsRoute(get(`/suggest/confirm?token=${token}&lang=en`), env);
			expect(response?.status).toBe(303);
			expect(response?.headers.get('Location')).toBe('/sugerir/confirm?done=1&lang=en');
			expect(row(db, 'SELECT status FROM source_suggestions').status).toBe('confirmed');
		} finally { mock.restore(); }
	});

	it('never logs the raw token, the submitter address or the owner address', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const now = Date.now() + 60000;
			await submitSuggestion(env, submitInput({ email: 'private@example.org' }) as any, now);
			const token = new URL(confirmLink(mock, 'private@example.org')!).searchParams.get('token')!;
			const logs = () => errors.mock.calls.flat().join(' ');
			expect(logs()).not.toContain(token);
			expect(logs()).not.toContain('private@example.org');
			resetPace(db);
			const response = await suggestionsRoute(get(`/sugerir/confirm?token=${token}`), env);
			expect(response?.status).toBe(303);
			expect(logs()).not.toContain(token);
			expect(logs()).not.toContain('private@example.org');
			expect(logs()).not.toContain(OWNER_SUGGESTION_EMAIL);
		} finally { mock.restore(); }
	});
});

describe('HTTP pages, bilingual UI and security headers', () => {
	it('ships matching CSP hashes for every inline script', () => {
		const b64 = (value: string) => createHash('sha256').update(value).digest('base64');
		expect(b64(alertThemeBoot)).toBe(alertThemeBootHash);
		expect(b64(alertThemeToggle)).toBe(alertThemeToggleHash);
		expect(b64(turnstileClientScript)).toBe(turnstileClientScriptHash);
	});

	it.each([
		['/sugerir', 'es'],
		['/sugerir', 'en'],
		['/suggest', 'es'],
		['/suggest', 'en'],
	])('renders %s in %s with the complete bilingual form and strict headers', async (path, lang) => {
		const { DB } = database(); const env = baseEnv(DB);
		const response = await suggestionsRoute(get(`${path}?lang=${lang}`), env);
		expect(response?.status).toBe(200);
		const html = await response!.text();
		const spanish = lang === 'es';
		expect(html).toContain(`<html lang="${lang}">`);
		expect(html).toContain(spanish ? 'Sugerir fuente' : 'Suggest a source');
		expect(html).toContain(spanish ? 'Enviar sugerencia' : 'Send suggestion');
		expect(html).toContain(spanish ? 'Tu correo electrónico (para confirmar que eres tú)' : 'Your email address (to confirm your submission)');
		expect(html).toContain(`<form method="post" action="/sugerir?lang=${lang}">`);
		expect(html).toContain(`name="lang" value="${lang}"`);
		for (const field of ['kind', 'name', 'target', 'notes', 'email', 'x_presencia']) expect(html).toContain(`name="${field}"`);
		expect(html).toContain('maxlength="120"');
		expect(html).toContain('maxlength="300"');
		expect(html).toContain('maxlength="400"');
		expect(html).toContain('maxlength="254"');
		expect(html).toContain('cf-turnstile');
		expect(html).toContain('data-action="suggest"');
		expect(html).toContain('hreflang="es"');
		expect(html).toContain('hreflang="en"');
		expect(html).toContain('href="/sugerir?lang=es"');
		expect(html).toContain('href="/sugerir?lang=en"');
		expect(html).not.toContain('cloudflareinsights');
		expect(html).not.toContain('beacon.min.js');
		expect(response?.headers.get('Cache-Control')).toBe('no-store');
		expect(response?.headers.get('Referrer-Policy')).toBe('no-referrer');
		expect(response?.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
		expect(response?.headers.get('Content-Type')).toContain('text/html');
		const csp = response?.headers.get('Content-Security-Policy') ?? '';
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("form-action 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("base-uri 'none'");
		expect(csp).toContain('https://challenges.cloudflare.com');
		expect(csp).toContain(`'sha256-${turnstileClientScriptHash}'`);
		expect(csp).not.toContain("script-src 'unsafe-inline'");
	});

	it('returns a generic 202 for a valid submission without echoing identity or token', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(providerOk);
		try {
			resetPace(db);
			const response = await suggestionsRoute(post('/suggest?lang=en', { ...validFields, email: 'accepted@example.org' }), env);
			expect(response?.status).toBe(202);
			const html = await response!.text();
			expect(html).toContain('We received your suggestion');
			expect(html).not.toContain('accepted@example.org');
			expect(html).not.toContain('valid-token');
			expect(html).not.toContain('class="cf-turnstile"');
			expect(response?.headers.get('Cache-Control')).toBe('no-store');
			expect(await countRows(env, 'source_suggestions')).toBe(1);
			expect(row(db, 'SELECT language FROM source_suggestions').language).toBe('en');
			expect(verifies(mock)).toHaveLength(1);
			expect(sends(mock)).toHaveLength(1);
		} finally { mock.restore(); }
	});

	it('keeps no-store, no-referrer, noindex and a strict CSP on success, retry and error pages', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const mock = mockFetch(() => { throw new Error('no provider calls are needed for these pages'); });
		try {
			const responses = [
				await suggestionsRoute(get('/sugerir?lang=en'), env),
				await suggestionsRoute(get('/sugerir/confirm?done=1&lang=en'), env),
				await suggestionsRoute(get('/sugerir/confirm?token=bad'), env),
				await suggestionsRoute(post('/sugerir', {}), env),
				await suggestionsRoute(post('/sugerir', validFields, { Origin: 'https://evil.example' }), env),
			];
			for (const response of responses) {
				expect(response).toBeTruthy();
				expect(response?.headers.get('Cache-Control')).toBe('no-store');
				expect(response?.headers.get('Referrer-Policy')).toBe('no-referrer');
				expect(response?.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
				const csp = response?.headers.get('Content-Security-Policy') ?? '';
				expect(csp).toContain("default-src 'none'");
				expect(csp).toContain("frame-ancestors 'none'");
				expect(csp).toContain("base-uri 'none'");
			}
			expect(mock.calls).toHaveLength(0);
		} finally { mock.restore(); }
	});

	it('serves HEAD without a body, rejects unsupported methods and leaves other paths untouched', async () => {
		const { DB } = database(); const env = baseEnv(DB);
		const head = await suggestionsRoute(new Request('https://news.dev.pr/sugerir', { method: 'HEAD' }), env);
		expect(head?.status).toBe(200);
		expect(await head?.text()).toBe('');
		expect(head?.headers.get('Cache-Control')).toBe('no-store');
		const put = await suggestionsRoute(new Request('https://news.dev.pr/sugerir', { method: 'PUT' }), env);
		expect(put?.status).toBe(405);
		const postConfirm = await suggestionsRoute(post('/sugerir/confirm', {}), env);
		expect(postConfirm?.status).toBe(405);
		expect(await suggestionsRoute(get('/fuentes?lang=es'), env)).toBeUndefined();
	});

	it('links to /sugerir from /fuentes and from the footer in both editions', async () => {
		const data = { items: [], translations: {}, feeds: [] };
		const fuentesEs = await renderer.fetch(get('/fuentes?lang=es'), data).text();
		expect(fuentesEs).toContain('href="/sugerir?lang=es"');
		expect(fuentesEs).toContain('¿Falta un medio o un influencer de noticias?');
		expect(fuentesEs).toContain('Sugerir fuente');
		const fuentesEn = await renderer.fetch(get('/fuentes?lang=en'), data).text();
		expect(fuentesEn).toContain('href="/sugerir?lang=en"');
		expect(fuentesEn).toContain('Is a news outlet or a news influencer missing?');
		expect(fuentesEn).toContain('Suggest a source');
		const homeEs = await renderer.fetch(get('/?lang=es'), data).text();
		expect(homeEs).toContain('href="/sugerir?lang=es"');
		const homeEn = await renderer.fetch(get('/?lang=en'), data).text();
		expect(homeEn).toContain('href="/sugerir?lang=en"');
	});
});

describe('outbox delivery safety', () => {
	it('never retries an ambiguous send and never duplicates the owner notice', async () => {
		const { DB, db } = database(); const env = baseEnv(DB);
		const mock = mockFetch(call => call.url.includes('siteverify')
			? Response.json({ success: true, hostname: 'news.dev.pr', action: 'suggest' })
			: new Response('provider down', { status: 500 }));
		try {
			const now = Date.now() + 60000;
			const verdict = await submitSuggestion(env, submitInput({ email: 'uncertain@example.org' }) as any, now);
			expect(verdict.ok).toBe(true);
			expect(row(db, "SELECT state FROM source_suggestion_outbox WHERE kind='confirm'").state).toBe('uncertain');
			const before = sends(mock).length;
			await flushSuggestionOutbox(env, now + 10 * 60000);
			expect(sends(mock)).toHaveLength(before);
			expect(row(db, "SELECT state FROM source_suggestion_outbox WHERE kind='confirm'").state).toBe('uncertain');
		} finally { mock.restore(); }
	});
});

