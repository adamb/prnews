/**
 * Owner-only Source Suggestions Admin dashboard backend: magic-link sign-in to exactly one
 * operator mailbox, scoped admin sessions, and the list/update/delete/export surface over the
 * source_suggestions table. Follows the alerts.ts and suggestions.ts conventions exactly:
 * hashed single-use tokens, a paced outbox whose ambiguous sends are never auto-retried, and
 * the shared alert_pace pacing row.
 *
 * Guarantees implemented here:
 *  - Strict owner lock: a sign-in token and mail are produced ONLY for ADMIN_EMAIL. Every
 *    other well-formed address gets the identical generic 'accepted' with no token row and no
 *    email, and the response never reveals whether an address is the owner.
 *  - Raw tokens and session secrets are never stored or logged; only SHA-256 hashes persist.
 *  - The magic-link payload is scrubbed to '{}' the moment the mail is accepted, so no raw
 *    login token lingers in D1.
 *  - Every query is parameterized; list filters are allowlisted and LIKE wildcards escaped.
 *  - CSV export escapes quotes and neutralizes spreadsheet formula injection.
 */
import type { SuggestionEnv, SuggestionKind, SuggestionLang } from './suggestions';
import { OWNER_SUGGESTION_EMAIL } from './suggestions';
import { sendMail, alertsSender } from './improvmx';
import { verifyTurnstile, turnstileRenderConfigured } from './turnstile';
import { hash } from './importance';

export const ADMIN_EMAIL = OWNER_SUGGESTION_EMAIL; // 'beguelin@gmail.com'
export const ADMIN_COOKIE = 'prnews_admin_session';
export type SuggestionStatus = 'pending' | 'confirmed' | 'reviewed' | 'rejected';

export interface AdminSession { id: string; email: string; csrf: string; expiresAt: number }
export interface AdminSuggestionRow {
	id: string;
	kind: SuggestionKind;
	name: string;
	target: string;
	notes: string;
	email: string;
	language: SuggestionLang;
	status: SuggestionStatus;
	admin_note: string;
	created_at: number;
	confirmed_at: number | null;
}
export interface SuggestionCounts {
	all: number;
	confirmed: number;
	pending: number;
	reviewed: number;
	rejected: number;
}
export interface ListSuggestionsResult {
	rows: AdminSuggestionRow[];
	counts: SuggestionCounts;
}
export type AdminSigninVerdict =
	| { ok: true; status: 'accepted' }
	| { ok: false; status: 'unavailable' | 'captcha' | 'invalid' };
export type AdminRedeemVerdict =
	| { ok: true; session: { secret: string; csrf: string; expiresAt: number } }
	| { ok: false; status: 'unavailable' | 'invalid' };

/* ------------------------------------------------------------------ constants */

const DAY = 86400000, ORIGIN = 'https://news.dev.pr';
/** Magic link path rendered inside the sign-in mail; served by src/admin-suggestions-http.ts
 * at /admin/in, token read from the `token` query parameter. */
const ADMIN_PATH = '/admin/in';
const ADMIN_TOKEN_TTL = 15 * 60000, ADMIN_SESSION_TTL = 7 * DAY;
/** Conservative global pacing, matching alerts.ts/suggestions.ts: 8s minimum interval / 8 per
 * minute / 200 per day. */
const MIN_SEND_INTERVAL_MS = 8000, MINUTE_SEND_CAP = 8, DAILY_SEND_CAP = 200;
const ADMIN_SIGNIN_DAILY = 10;
const MAX_ATTEMPTS = 5, SENDS_PER_RUN = 20;
const MAX_QUERY_CHARS = 100, MAX_NOTE_CHARS = 500;
const MAX_LIST_ROWS = 500, DEFAULT_LIST_ROWS = 200;

/* ------------------------------------------------------------------ helpers */

const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
/** Single-line sanitizer: strip every ASCII control character (incl. CR/LF/tab) and collapse
 * the resulting whitespace, so a field can never inject an email header or forge a log line. */
const oneLine = (s: string) => s.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/ +/g, ' ').trim();
/** Same RFC-like shape check as alerts.ts/suggestions.ts. */
const validEmail = (email: string) => email.length > 3 && email.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email);
/** Admin note sanitizer: allow newlines only. Every other control character (incl. tab) is
 * removed, then the note is capped at MAX_NOTE_CHARS. */
const sanitizeAdminNote = (value: unknown): string => {
	if (typeof value !== 'string') return '';
	return value.replace(/\r\n/g, '\n').replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/\r/g, '\n').slice(0, MAX_NOTE_CHARS);
};

/** Shared bounded daily counter (same table and upsert as alerts.ts/suggestions.ts). */
async function dailyCount(env: SuggestionEnv, bucket: string, day: number, cap: number): Promise<boolean> {
	const row = await env.DB.prepare('INSERT INTO alert_limits(bucket,day,count) VALUES(?,?,1) ON CONFLICT(bucket,day) DO UPDATE SET count=count+1 WHERE count<? RETURNING count').bind(bucket, day, cap).first<{ count: number }>();
	return !!row;
}

/** One globally paced slot on the shared alert_pace row (8s minimum interval / 8 per minute). */
async function paceGate(env: SuggestionEnv, now: number): Promise<void> {
	await env.DB.prepare("INSERT OR IGNORE INTO alert_pace(id,last_send,minute,minute_count) VALUES('pace',0,0,0)").run();
	const pace = await env.DB.prepare("SELECT last_send,minute,minute_count FROM alert_pace WHERE id='pace'").first<{ last_send: number; minute: number; minute_count: number }>();
	if (!pace) return;
	const minute = Math.floor(now / 60000);
	let wait = 0;
	if (now - pace.last_send < MIN_SEND_INTERVAL_MS) wait += MIN_SEND_INTERVAL_MS - (now - pace.last_send);
	if (pace.minute === minute && pace.minute_count >= MINUTE_SEND_CAP) wait += 60000 - (now % 60000);
	if (wait > 0) await new Promise(resolve => setTimeout(resolve, Math.min(wait, 120000)));
	const stampedAt = Date.now(), stampedMinute = Math.floor(stampedAt / 60000);
	const reserved = await env.DB.prepare("UPDATE alert_pace SET last_send=?, minute_count=CASE WHEN minute=? THEN minute_count+1 ELSE 1 END, minute=CASE WHEN minute=? THEN minute ELSE ? END WHERE id='pace' AND last_send=?")
		.bind(stampedAt, stampedMinute, stampedMinute, stampedMinute, pace.last_send).run();
	if (!reserved.meta.changes) await paceGate(env, Date.now());
}

async function createAdminOutbox(env: SuggestionEnv, email: string, payload: Record<string, unknown>, now: number): Promise<string> {
	const id = crypto.randomUUID();
	// The outbox id doubles as the subject reference for delivery attribution; it is opaque.
	const stamped = JSON.stringify({ ...payload, ref: id.slice(0, 8) });
	const inserted = await env.DB.prepare('INSERT INTO admin_outbox(id,email,payload,state,created_at) VALUES(?,?,?,?,?)')
		.bind(id, email, stamped, 'pending', now).run();
	return inserted.meta.changes ? id : '';
}

/* ------------------------------------------------------------------ sign-in */

export const adminConfigured = (env: SuggestionEnv) => !!alertsSender(env);
/** Public sign-in needs BOTH the mail provider and the full Turnstile render/verify triangle. */
export const publicAdminConfigured = (env: SuggestionEnv) => adminConfigured(env) && turnstileRenderConfigured(env);

/** Owner-only magic-link sign-in. Every well-formed non-owner address gets the identical
 * generic 'accepted' with no token row and no email; nothing about ownership is revealed. */
export async function requestAdminSignin(
	env: SuggestionEnv,
	input: { email: unknown; captcha?: unknown; honeypot?: unknown; ip?: string | null; language?: unknown },
	now = Date.now(),
): Promise<AdminSigninVerdict> {
	if (!publicAdminConfigured(env)) return { ok: false, status: 'unavailable' };
	// Verify first: the token is checked before anything reads or writes the database.
	const verified = await verifyTurnstile(env, input.captcha, input.ip ?? null, 'admin_signin');
	if (input.honeypot && !verified) { console.error('admin_signin_gate honeypot'); return { ok: true, status: 'accepted' }; }
	if (input.honeypot && verified) console.error('admin_signin_gate honeypot-autofill-accepted');
	if (!verified) return { ok: false, status: 'captcha' };
	if (typeof input.email !== 'string') return { ok: false, status: 'invalid' };
	const email = oneLine(input.email).toLowerCase();
	if (!validEmail(email)) return { ok: false, status: 'invalid' };
	if (!await dailyCount(env, 'admin_signin', Math.floor(now / DAY), ADMIN_SIGNIN_DAILY)) return { ok: true, status: 'accepted' };
	// Strict owner lock: only the operator mailbox ever produces a token or a mail.
	if (email !== ADMIN_EMAIL) return { ok: true, status: 'accepted' };
	const token = randomToken();
	const inserted = await env.DB.prepare('INSERT INTO admin_tokens(id,email,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)')
		.bind(crypto.randomUUID(), ADMIN_EMAIL, await hash(token), now + ADMIN_TOKEN_TTL, now).run();
	if (!inserted.meta.changes) return { ok: true, status: 'accepted' };
	const outboxId = await createAdminOutbox(env, ADMIN_EMAIL, { token, language: input.language === 'en' ? 'en' : 'es' }, now);
	if (outboxId) await tryImmediateFlush(env, outboxId, now);
	return { ok: true, status: 'accepted' };
}

/** Single-use redemption of the admin magic link. Claims the token atomically before opening
 * a session, so a replay finds the token already used and returns 'invalid'. */
export async function redeemAdminToken(env: SuggestionEnv, rawToken: string, now = Date.now()): Promise<AdminRedeemVerdict> {
	if (!adminConfigured(env)) return { ok: false, status: 'unavailable' };
	if (!/^[a-f0-9]{64}$/.test(rawToken)) return { ok: false, status: 'invalid' };
	const row = await env.DB.prepare('SELECT id FROM admin_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>? AND email=?')
		.bind(await hash(rawToken), now, ADMIN_EMAIL).first<{ id: string }>();
	if (!row) return { ok: false, status: 'invalid' };
	const claim = await env.DB.prepare('UPDATE admin_tokens SET used_at=? WHERE id=? AND used_at IS NULL').bind(now, row.id).run();
	if (!claim.meta.changes) return { ok: false, status: 'invalid' };
	const session = await createAdminSession(env, now);
	if (!session) return { ok: false, status: 'invalid' };
	return { ok: true, session };
}

async function createAdminSession(env: SuggestionEnv, now: number): Promise<{ secret: string; csrf: string; expiresAt: number } | null> {
	const secret = randomToken();
	const csrf = randomToken();
	const inserted = await env.DB.prepare('INSERT INTO admin_sessions(id,email,token_hash,csrf,created_at,expires_at) VALUES(?,?,?,?,?,?)')
		.bind(crypto.randomUUID(), ADMIN_EMAIL, await hash(secret), csrf, now, now + ADMIN_SESSION_TTL).run();
	if (!inserted.meta.changes) return null;
	return { secret, csrf, expiresAt: now + ADMIN_SESSION_TTL };
}

/* ------------------------------------------------------------------ sessions */

export async function adminSessionFromCookie(env: SuggestionEnv, secret: string | undefined, now = Date.now()): Promise<AdminSession | null> {
	if (!secret || secret.length > 128) return null;
	const row = await env.DB.prepare('SELECT id,email,csrf,expires_at FROM admin_sessions WHERE token_hash=? AND expires_at>? AND email=?')
		.bind(await hash(secret), now, ADMIN_EMAIL).first<{ id: string; email: string; csrf: string; expires_at: number }>();
	if (!row) return null;
	return { id: row.id, email: row.email, csrf: row.csrf, expiresAt: row.expires_at };
}

export async function signOutAdmin(env: SuggestionEnv, secret: string | undefined): Promise<void> {
	if (!secret || secret.length > 128) return;
	await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(await hash(secret)).run();
}

/* ------------------------------------------------------------------ outbox flush */

interface AdminOutboxRow { id: string; email: string; payload: string; attempts: number; created_at: number }

/** A claimed 'sending' row whose lease expired is crash recovery: acceptance is unknown, so it
 * becomes 'uncertain' and is never auto-resent. */
async function recoverSending(env: SuggestionEnv, now: number): Promise<void> {
	await env.DB.prepare("UPDATE admin_outbox SET state='uncertain',attempt_at=COALESCE(attempt_at,created_at) WHERE state='sending' AND lease_until<?").bind(now).run();
}

export async function flushAdminOutbox(env: SuggestionEnv, now = Date.now()): Promise<{ sent: number; failed: number; deferred: number }> {
	if (!adminConfigured(env)) return { sent: 0, failed: 0, deferred: 0 };
	await recoverSending(env, now);
	return dispatchAdmin(env, now, null);
}

/** Attempt an immediate paced flush for a single just-enqueued row, so a busy slot never
 * defers to cron. Claimed rows remain available for conservative lease recovery on failure. */
async function tryImmediateFlush(env: SuggestionEnv, outboxId: string, now: number): Promise<void> {
	try { await dispatchAdmin(env, now, outboxId); }
	catch { /* Claimed rows remain available for conservative lease recovery. */ }
}

async function dispatchAdmin(env: SuggestionEnv, now: number, outboxId: string | null): Promise<{ sent: number; failed: number; deferred: number }> {
	const rows = await env.DB.prepare("SELECT id,email,payload,attempts,created_at FROM admin_outbox WHERE state='pending' AND lease_until<=? AND attempts<? AND email=? AND (? IS NULL OR id=?) ORDER BY created_at LIMIT ?")
		.bind(now, MAX_ATTEMPTS, ADMIN_EMAIL, outboxId, outboxId, SENDS_PER_RUN).all<AdminOutboxRow>();
	let sent = 0, failed = 0, deferred = 0;
	for (let i = 0; i < rows.results.length; i++) {
		const row = rows.results[i];
		if (!(await dailyCount(env, 'send', Math.floor(now / DAY), DAILY_SEND_CAP))) { deferred += rows.results.length - i; break; }
		const claim = await env.DB.prepare("UPDATE admin_outbox SET state='sending',lease_until=?,attempts=attempts+1,attempt_at=COALESCE(attempt_at,?) WHERE id=? AND state='pending' AND lease_until<=? AND attempts<?")
			.bind(now + 120000, now, row.id, now, MAX_ATTEMPTS).run();
		if (!claim.meta.changes) continue;
		const mail = renderAdminEmail(row);
		if (!mail) {
			await env.DB.prepare("UPDATE admin_outbox SET state='failed' WHERE id=?").bind(row.id).run();
			failed++;
			continue;
		}
		await paceGate(env, now);
		const verdict = await sendMail(env, mail);
		if (verdict.state === 'throttled') {
			await env.DB.prepare("UPDATE admin_outbox SET state='pending',lease_until=?,attempts=MAX(attempts-1,0) WHERE id=?").bind(verdict.retryAt, row.id).run();
			deferred += rows.results.length - i;
			break;
		}
		if (verdict.state === 'sent') {
			// Scrub the raw login token the moment the mail is accepted.
			await env.DB.prepare("UPDATE admin_outbox SET state='sent',sent_at=?,provider_ref=?,payload='{}' WHERE id=?").bind(Date.now(), verdict.ref, row.id).run();
			sent++;
		} else if (verdict.state === 'rejected') {
			await env.DB.prepare("UPDATE admin_outbox SET state='failed' WHERE id=?").bind(row.id).run();
			failed++;
		} else {
			await env.DB.prepare("UPDATE admin_outbox SET state='uncertain',attempt_at=? WHERE id=?").bind(now, row.id).run();
			deferred++;
		}
	}
	return { sent, failed, deferred };
}

/** Renders the stored payload with everything the mail needs. All interpolation is escaped;
 * subject text is reduced to one line and carries the opaque attribution reference. */
function renderAdminEmail(row: AdminOutboxRow): { to: string; subject: string; text: string; html: string } | undefined {
	if (row.email !== ADMIN_EMAIL) return undefined;
	const payload = JSON.parse(row.payload) as { ref?: string; token?: string; language?: string };
	const tag = ` [#${payload.ref ?? row.id.slice(0, 8)}]`;
	const token = payload.token ?? '';
	if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
	const es = payload.language !== 'en';
	const link = `${ORIGIN}${ADMIN_PATH}?token=${token}${payload.language === 'en' ? '&lang=en' : ''}`;
	const subject = oneLine(es ? `Acceso de administración · news.dev.pr${tag}` : `Admin sign-in · news.dev.pr${tag}`);
	return {
		to: row.email, subject,
		text: (es ? 'Accede al panel de administración con este enlace (vence en 15 minutos): ' : 'Sign in to the admin dashboard with this link (expires in 15 minutes): ') + link,
		html: `<p>${es ? 'Accede al panel de administración con este enlace (vence en 15 minutos):' : 'Sign in to the admin dashboard with this link (expires in 15 minutes):'}</p><p><a href="${link}">${link}</a></p><p>${es ? 'Si no solicitaste este acceso, ignora este correo.' : 'If you did not request this, ignore this email.'}</p>`,
	};
}

/* ------------------------------------------------------------------ list / mutate / export */

const STATUSES: SuggestionStatus[] = ['pending', 'confirmed', 'reviewed', 'rejected'];
const clampLimit = (limit: unknown): number => {
	const n = typeof limit === 'number' && Number.isInteger(limit) ? limit : DEFAULT_LIST_ROWS;
	return Math.max(1, Math.min(n, MAX_LIST_ROWS));
};

export async function listSuggestions(
	env: SuggestionEnv,
	filter: { status?: string; kind?: string; q?: string; limit?: number } = {},
): Promise<ListSuggestionsResult> {
	const clauses: string[] = [];
	const binds: (string | number)[] = [];
	if (filter.status && (STATUSES as string[]).includes(filter.status)) {
		clauses.push('status=?');
		binds.push(filter.status);
	}
	if (filter.kind === 'site' || filter.kind === 'influencer') {
		clauses.push('kind=?');
		binds.push(filter.kind);
	}
	const q = typeof filter.q === 'string' ? filter.q.slice(0, MAX_QUERY_CHARS) : '';
	if (q) {
		const escaped = q.replace(/[\\%_]/g, '\\$&');
		const like = `%${escaped}%`;
		clauses.push("(name LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')");
		binds.push(like, like, like, like);
	}
	const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
	const rows = await env.DB.prepare(`SELECT id,kind,name,target,notes,email,language,status,admin_note,created_at,confirmed_at FROM source_suggestions${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
		.bind(...binds, clampLimit(filter.limit)).all<AdminSuggestionRow>();
	const countsRow = await env.DB.prepare(`SELECT COUNT(*) AS "all", COALESCE(SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END),0) AS confirmed, COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending, COALESCE(SUM(CASE WHEN status='reviewed' THEN 1 ELSE 0 END),0) AS reviewed, COALESCE(SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END),0) AS rejected FROM source_suggestions`)
		.first<{ all: number; confirmed: number; pending: number; reviewed: number; rejected: number }>();
	const counts: SuggestionCounts = countsRow
		? { all: Number(countsRow.all ?? 0), confirmed: Number(countsRow.confirmed ?? 0), pending: Number(countsRow.pending ?? 0), reviewed: Number(countsRow.reviewed ?? 0), rejected: Number(countsRow.rejected ?? 0) }
		: { all: 0, confirmed: 0, pending: 0, reviewed: 0, rejected: 0 };
	return { rows: rows.results, counts };
}

export async function updateSuggestionStatus(
	env: SuggestionEnv,
	input: { id: string; status: SuggestionStatus; adminNote?: string },
): Promise<boolean> {
	if (!(STATUSES as string[]).includes(input.status)) return false;
	if (typeof input.id !== 'string' || !input.id) return false;
	const note = sanitizeAdminNote(input.adminNote);
	const updated = await env.DB.prepare('UPDATE source_suggestions SET status=?, admin_note=? WHERE id=?')
		.bind(input.status, note, input.id).run();
	return Number(updated.meta.changes ?? 0) > 0;
}

export async function deleteSuggestion(env: SuggestionEnv, id: string): Promise<boolean> {
	if (typeof id !== 'string' || !id) return false;
	await env.DB.prepare('DELETE FROM source_suggestion_tokens WHERE suggestion_id=?').bind(id).run();
	await env.DB.prepare('DELETE FROM source_suggestion_outbox WHERE suggestion_id=?').bind(id).run();
	const removed = await env.DB.prepare('DELETE FROM source_suggestions WHERE id=?').bind(id).run();
	return Number(removed.meta.changes ?? 0) > 0;
}

/** Spreadsheet-safe CSV: quotes are doubled and any cell starting with =, +, -, @, tab or CR
 * (after optional leading whitespace) is prefixed with an apostrophe to block formula injection. */
const csvCell = (value: unknown): string => {
	let s = value == null ? '' : String(value);
	if (/^\s*[=+\-@\t\r]/.test(s)) s = "'" + s;
	if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
	return s;
};

export async function exportSuggestionsCsv(env: SuggestionEnv): Promise<string> {
	const rows = await env.DB.prepare('SELECT kind,name,target,notes,email,language,status,admin_note,created_at,confirmed_at FROM source_suggestions ORDER BY created_at DESC, id DESC')
		.all<{ kind: string; name: string; target: string; notes: string; email: string; language: string; status: string; admin_note: string; created_at: number; confirmed_at: number | null }>();
	const header = ['kind', 'name', 'target', 'notes', 'email', 'language', 'status', 'admin_note', 'created_at', 'confirmed_at'] as const;
	const lines = [header.join(',')];
	for (const row of rows.results) {
		lines.push(header.map(h => csvCell(row[h])).join(','));
	}
	return lines.join('\n');
}
