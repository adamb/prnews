/**
 * Source suggestions (sites and influencers) backend: a public submission form gated by
 * Cloudflare Turnstile and a honeypot, double opt-in through a hashed single-use token, and a
 * paced ImprovMX outbox that follows the exact conventions of keyword alerts (alerts.ts).
 *
 * Guarantees implemented here (agreed flow):
 *  - Public submission is gated by Turnstile; missing configuration keeps it disabled
 *    (truthful UI), never an unprotected public email endpoint.
 *  - Every field is sanitized against email-header injection and log forging: ASCII control
 *    characters are stripped and CR/LF/tab collapsed before any database write or mail send.
 *  - The double opt-in token is 32 random bytes; only its SHA-256 hash is stored, it expires
 *    in 24 hours, and it is single-use (claimed atomically before the suggestion is marked
 *    confirmed).
 *  - Rate limits use the shared alert_limits table (a global per-day cap and a per-address
 *    per-day cap) without ever disclosing whether an address is known or throttled.
 *  - Confirm and owner mail flow through source_suggestion_outbox and the shared alert_pace
 *    row (8s minimum interval / 8 per minute), using the same sendMail transport as alerts.
 *    Ambiguous outcomes become 'uncertain' and are never auto-resent.
 *  - Tokens, emails, and provider errors are never logged; raw user input is never logged and
 *    the owner notice renders only escaped, sanitized text (no raw HTML).
 */
import { sendMail, alertsSender, type ImprovMXEnv } from './improvmx';
import { verifyTurnstile, turnstileRenderConfigured, type TurnstileEnv } from './turnstile';
import { hash } from './importance';

export type SuggestionKind = 'site' | 'influencer';
export type SuggestionLang = 'es' | 'en';

export interface SuggestionEnv extends ImprovMXEnv, TurnstileEnv {
	DB: D1Database;
	CONTACT_EMAIL?: string;
	DIGEST_TOKEN_SECRET?: string;
}

export interface SuggestionInput {
	kind: unknown;
	name: unknown;
	target: unknown;
	notes?: unknown;
	email: unknown;
	language?: unknown;
	turnstileToken?: unknown;
	honeypot?: unknown;
	ip?: string | null;
}

export interface SanitizedSuggestion {
	kind: SuggestionKind;
	name: string;
	target: string;
	notes: string;
	email: string;
	language: SuggestionLang;
}

export type SanitizeResult = { ok: true; value: SanitizedSuggestion } | { ok: false; field: 'kind' | 'name' | 'target' | 'notes' | 'email'; reason: string };

export type SubmitVerdict =
	| { ok: true; status: 'accepted'; message: string }
	| { ok: false; status: 'unavailable' | 'captcha' | 'invalid' | 'rate_limited'; field?: string; message: string };

export type ConfirmVerdict =
	| { ok: true; status: 'confirmed'; kind: SuggestionKind; name: string; language: SuggestionLang }
	| { ok: false; status: 'invalid' | 'unavailable'; message: string };

/** Operator mailbox for the confirmed-suggestion notice. Not a secret. Public pages do not print it. */
export const OWNER_SUGGESTION_EMAIL = 'beguelin@gmail.com';

const DAY = 86400000, ORIGIN = 'https://news.dev.pr';
/** Confirm path rendered inside the opt-in mail; served by src/suggestions-http.ts at
 * /sugerir/confirm (alias /suggest/confirm), token read from the `token` query parameter. */
const CONFIRM_PATH = '/sugerir/confirm';
const CONFIRM_TTL = DAY;
/** Conservative global pacing, matching alerts.ts: ImprovMX sends share one 10 requests/minute
 * limit and a daily quota with SMTP, so stay under both (8/minute, 200/day). */
const MIN_SEND_INTERVAL_MS = 8000, MINUTE_SEND_CAP = 8, DAILY_SEND_CAP = 200;
const GLOBAL_SUGGEST_DAILY = 30, EMAIL_SUGGEST_DAILY = 3;
const MAX_ATTEMPTS = 5, SENDS_PER_RUN = 20;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
/** Single-line sanitizer: strip every ASCII control character (incl. CR/LF/tab) and collapse
 * the resulting whitespace, so a field can never inject an email header or forge a log line. */
const oneLine = (s: string) => s.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/ +/g, ' ').trim();
/** Notes sanitizer: allow newlines only. CR/LF collapse to LF, every other control char is
 * removed, so a free-text note can never carry a header or log-forging byte. */
const sanitizeNotes = (s: string) => s.replace(/\r\n/g, '\n').replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/\r/g, '\n').trim();
/** Same RFC-like shape check as alerts.ts. */
const validEmail = (email: string) => email.length > 3 && email.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email);

export const suggestionsConfigured = (env: SuggestionEnv) => !!alertsSender(env);
/** Public submission needs BOTH the mail provider and the full Turnstile render/verify triangle. */
export const publicSuggestionsConfigured = (env: SuggestionEnv) => suggestionsConfigured(env) && turnstileRenderConfigured(env);

const genericMessage = 'Si corresponde, recibirás un correo. Revisa tu bandeja. / If eligible, an email will arrive; check your inbox.';
const unavailableMessage = 'El servicio de sugerencias no está disponible temporalmente. / The suggestions service is temporarily unavailable.';
const captchaMessage = 'No pudimos verificar tu envío. Vuelve a intentarlo. / We could not verify your submission. Please try again.';
const invalidMessage = 'Revisa los datos ingresados. / Please review the details you entered.';
const rateLimitedMessage = 'Recibimos demasiados envíos. Intenta más tarde. / Too many submissions right now. Please try again later.';

/* ------------------------------------------------------------------ target validation */

/** Rejects loopback/private hosts so a suggestion can never point at an internal address. */
function isPrivateHost(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, '');
	if (h === 'localhost' || h.endsWith('.localhost')) return true;
	if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa') || h.endsWith('.lan')) return true;
	if (h.includes(':')) return true; // any IPv6 literal is rejected: sites are real hostnames
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
		const p = h.split('.').map(Number);
		if (p.some(n => Number.isNaN(n) || n > 255)) return true;
		const [a, b] = p;
		return a === 0 || a === 10 || a === 127
			|| (a === 169 && b === 254)
			|| (a === 172 && b >= 16 && b <= 31)
			|| (a === 192 && b === 168)
			|| (a === 100 && b >= 64 && b <= 127)
			|| a >= 224;
	}
	return false;
}

/** Accepts only an http(s) URL with a real dotted hostname; prepends https:// when no scheme
 * is present (e.g. `example.com`). Rejects javascript:, data:, vbscript:, file:, ftp: and any
 * other scheme, credentials, or loopback/private hosts. Returns the normalized URL or ''. */
function normalizeUrl(raw: string): string {
	let value = raw;
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
		const scheme = value.slice(0, value.indexOf(':')).toLowerCase();
		if (scheme !== 'http' && scheme !== 'https') return '';
	} else {
		value = 'https://' + value;
	}
	let u: URL;
	try { u = new URL(value); } catch { return ''; }
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
	if (u.username || u.password) return '';
	const host = u.hostname.toLowerCase().replace(/\.$/, '');
	if (!host || !host.includes('.')) return '';
	if (isPrivateHost(host)) return '';
	return u.href;
}

/** A clean social handle: `@username` (2..64 letters/numbers/._-), optionally prefixed with a
 * platform like `X: @handle` or `Instagram @handle`. Returns the handle or ''. */
function cleanHandle(raw: string): string {
	return /^(?:[A-Za-z0-9._-]{1,30}(?::|\s)\s*)?@([A-Za-z0-9._-]{2,64})$/.test(raw) ? raw : '';
}

/* ------------------------------------------------------------------ sanitization */

export function sanitizeSuggestionInput(input: Pick<SuggestionInput, 'kind' | 'name' | 'target' | 'notes' | 'email' | 'language'>): SanitizeResult {
	if (input.kind !== 'site' && input.kind !== 'influencer') return { ok: false, field: 'kind', reason: 'kind must be "site" or "influencer"' };
	if (typeof input.name !== 'string') return { ok: false, field: 'name', reason: 'name is required' };
	const name = oneLine(input.name);
	if (name.length < 2 || name.length > 120) return { ok: false, field: 'name', reason: 'name must be 2-120 characters' };
	if (typeof input.target !== 'string') return { ok: false, field: 'target', reason: 'target is required' };
	const target = oneLine(input.target);
	if (target.length < 2 || target.length > 300) return { ok: false, field: 'target', reason: 'target must be 2-300 characters' };
	const cleanTarget = input.kind === 'site' ? normalizeUrl(target) : (normalizeUrl(target) || cleanHandle(target));
	if (!cleanTarget) return { ok: false, field: 'target', reason: 'target must be an http(s) URL or a social handle' };
	const notes = typeof input.notes === 'string' ? sanitizeNotes(input.notes) : '';
	if (notes.length > 400) return { ok: false, field: 'notes', reason: 'notes must be 400 characters or fewer' };
	if (typeof input.email !== 'string') return { ok: false, field: 'email', reason: 'email is required' };
	const email = oneLine(input.email).toLowerCase();
	if (!validEmail(email)) return { ok: false, field: 'email', reason: 'email is not valid' };
	const language: SuggestionLang = input.language === 'en' ? 'en' : 'es';
	return { ok: true, value: { kind: input.kind, name, target: cleanTarget, notes, email, language } };
}

/* ------------------------------------------------------------------ helpers */

/** Shared bounded daily counter (same table and upsert as alerts.ts). Returns false when the
 * cap is already reached, so callers answer generically instead of disclosing throttle state. */
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

async function createOutbox(env: SuggestionEnv, kind: 'confirm' | 'owner', suggestionId: string, email: string, payload: Record<string, unknown>, now: number): Promise<string> {
	const id = crypto.randomUUID();
	// The outbox id doubles as the subject reference for delivery attribution; it is opaque.
	const stamped = JSON.stringify({ ...payload, ref: id.slice(0, 8) });
	const inserted = await env.DB.prepare('INSERT INTO source_suggestion_outbox(id,kind,suggestion_id,email,payload,state,created_at) VALUES(?,?,?,?,?,?,?)')
		.bind(id, kind, suggestionId, email, stamped, 'pending', now).run();
	return inserted.meta.changes ? id : '';
}

/* ------------------------------------------------------------------ submit */

export async function submitSuggestion(env: SuggestionEnv, input: SuggestionInput, now = Date.now()): Promise<SubmitVerdict> {
	let outcome = 'exception';
	try {
		const verdict = await submitAttempt(env, input, now);
		outcome = verdict.ok ? 'accepted' : verdict.status;
		return verdict;
	} finally {
		try {
			await env.DB.prepare('INSERT INTO alert_limits(bucket,day,count) VALUES(?,?,1) ON CONFLICT(bucket,day) DO UPDATE SET count=count+1')
				.bind('suggest-outcome:' + outcome, Math.floor(now / DAY)).run();
		} catch { console.error('suggestions_outcome_write_failed'); }
	}
}

async function submitAttempt(env: SuggestionEnv, input: SuggestionInput, now: number): Promise<SubmitVerdict> {
	if (!publicSuggestionsConfigured(env)) return { ok: false, status: 'unavailable', message: unavailableMessage };
	// Verify first: the token is checked before anything reads or writes the database, and a
	// VERIFIED token overrides the honeypot (real users whose autofill fills the decoy).
	const verified = await verifyTurnstile(env, input.turnstileToken, input.ip ?? null, 'suggest');
	if (input.honeypot && !verified) { console.error('suggestions_gate honeypot submit'); return { ok: true, status: 'accepted', message: genericMessage }; }
	if (input.honeypot && verified) console.error('suggestions_gate honeypot-autofill-accepted submit');
	if (!verified) return { ok: false, status: 'captcha', message: captchaMessage };
	const sanitized = sanitizeSuggestionInput(input);
	if (!sanitized.ok) return { ok: false, status: 'invalid', field: sanitized.field, message: invalidMessage };
	const value = sanitized.value;
	// Check per-address cap first so an already-capped address cannot exhaust the global quota.
	if (!await dailyCount(env, 'suggest_email:' + await hash(value.email), Math.floor(now / DAY), EMAIL_SUGGEST_DAILY)) return { ok: true, status: 'accepted', message: genericMessage };
	if (!await dailyCount(env, 'suggest_global', Math.floor(now / DAY), GLOBAL_SUGGEST_DAILY)) return { ok: false, status: 'rate_limited', message: rateLimitedMessage };
	const id = crypto.randomUUID();
	await env.DB.prepare('INSERT INTO source_suggestions(id,kind,name,target,notes,email,language,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
		.bind(id, value.kind, value.name, value.target, value.notes, value.email, value.language, 'pending', now).run();
	const token = randomToken();
	await env.DB.prepare('INSERT INTO source_suggestion_tokens(id,suggestion_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)')
		.bind(crypto.randomUUID(), id, await hash(token), now + CONFIRM_TTL, now).run();
	const outboxId = await createOutbox(env, 'confirm', id, value.email, { token, kind: value.kind, name: value.name, language: value.language }, now);
	if (outboxId) await tryImmediateFlush(env, outboxId, now);
	return { ok: true, status: 'accepted', message: genericMessage };
}

/* ------------------------------------------------------------------ confirm */

export async function confirmSuggestion(env: SuggestionEnv, rawToken: string, now = Date.now()): Promise<ConfirmVerdict> {
	if (!suggestionsConfigured(env)) return { ok: false, status: 'unavailable', message: unavailableMessage };
	if (!/^[a-f0-9]{64}$/.test(rawToken)) return { ok: false, status: 'invalid', message: invalidMessage };
	const row = await env.DB.prepare('SELECT t.id,t.suggestion_id,s.kind,s.name,s.language FROM source_suggestion_tokens t JOIN source_suggestions s ON s.id=t.suggestion_id WHERE t.token_hash=? AND t.used_at IS NULL AND t.expires_at>?')
		.bind(await hash(rawToken), now).first<{ id: string; suggestion_id: string; kind: string; name: string; language: string }>();
	if (!row) return { ok: false, status: 'invalid', message: invalidMessage };
	const claim = await env.DB.prepare('UPDATE source_suggestion_tokens SET used_at=? WHERE id=? AND used_at IS NULL').bind(now, row.id).run();
	if (!claim.meta.changes) return { ok: false, status: 'invalid', message: invalidMessage };
	const confirmed = await env.DB.prepare("UPDATE source_suggestions SET status='confirmed',confirmed_at=? WHERE id=? AND status='pending'").bind(now, row.suggestion_id).run();
	// First transition only; a replay finds the token already used and enqueues nothing.
	if (Number(confirmed.meta?.changes ?? 0) > 0) {
		try {
			const noticeId = await recordOwnerNotice(env, row.suggestion_id, now);
			if (noticeId) await tryImmediateFlush(env, noticeId, now);
		} catch {
			console.error('suggestions_owner_notice_failed');
		}
	}
	const kind: SuggestionKind = row.kind === 'influencer' ? 'influencer' : 'site';
	const language: SuggestionLang = row.language === 'en' ? 'en' : 'es';
	return { ok: true, status: 'confirmed', kind, name: row.name, language };
}

/** One operator notice per confirmed suggestion, containing only sanitized (already
 * control-stripped) details. The owner mail does not depend on the visitor's confirmation. */
async function recordOwnerNotice(env: SuggestionEnv, suggestionId: string, now: number): Promise<string> {
	const s = await env.DB.prepare('SELECT kind,name,target,notes FROM source_suggestions WHERE id=?').bind(suggestionId).first<{ kind: string; name: string; target: string; notes: string }>();
	if (!s) return '';
	return createOutbox(env, 'owner', suggestionId, OWNER_SUGGESTION_EMAIL, {
		kind: s.kind, name: s.name, target: s.target, notes: s.notes, confirmedAt: now,
	}, now);
}

/* ------------------------------------------------------------------ outbox flush */

interface OutboxRow { id: string; kind: 'confirm' | 'owner'; suggestion_id: string; email: string; payload: string; attempts: number; created_at: number }

/** A claimed 'sending' row whose lease expired is crash recovery: acceptance is unknown, so it
 * becomes 'uncertain' and is never auto-resent. */
async function recoverSending(env: SuggestionEnv, now: number): Promise<void> {
	await env.DB.prepare("UPDATE source_suggestion_outbox SET state='uncertain',attempt_at=COALESCE(attempt_at,created_at) WHERE state='sending' AND lease_until<?").bind(now).run();
}

export async function flushSuggestionOutbox(env: SuggestionEnv, now = Date.now()): Promise<{ sent: number; failed: number; deferred: number }> {
	if (!suggestionsConfigured(env)) return { sent: 0, failed: 0, deferred: 0 };
	await recoverSending(env, now);
	return dispatchSuggestion(env, now, null);
}

/** Attempt an immediate paced flush for a single just-enqueued row, so a busy slot never
 * defers to cron. Claimed rows remain available for conservative lease recovery on failure. */
async function tryImmediateFlush(env: SuggestionEnv, outboxId: string, now: number): Promise<void> {
	try { await dispatchSuggestion(env, now, outboxId); }
	catch { /* Claimed rows remain available for conservative lease recovery. */ }
}

async function dispatchSuggestion(env: SuggestionEnv, now: number, outboxId: string | null): Promise<{ sent: number; failed: number; deferred: number }> {
	const rows = await env.DB.prepare("SELECT id,kind,suggestion_id,email,payload,attempts,created_at FROM source_suggestion_outbox WHERE state='pending' AND lease_until<=? AND attempts<? AND (? IS NULL OR id=?) ORDER BY created_at LIMIT ?")
		.bind(now, MAX_ATTEMPTS, outboxId, outboxId, SENDS_PER_RUN).all<OutboxRow>();
	let sent = 0, failed = 0, deferred = 0;
	for (let i = 0; i < rows.results.length; i++) {
		const row = rows.results[i];
		if (!(await dailyCount(env, 'send', Math.floor(now / DAY), DAILY_SEND_CAP))) { deferred += rows.results.length - i; break; }
		const claim = await env.DB.prepare("UPDATE source_suggestion_outbox SET state='sending',lease_until=?,attempts=attempts+1,attempt_at=COALESCE(attempt_at,?) WHERE id=? AND state='pending' AND lease_until<=? AND attempts<?")
			.bind(now + 120000, now, row.id, now, MAX_ATTEMPTS).run();
		if (!claim.meta.changes) continue;
		const mail = renderSuggestionEmail(row);
		if (!mail) {
			await env.DB.prepare("UPDATE source_suggestion_outbox SET state='failed' WHERE id=?").bind(row.id).run();
			failed++;
			continue;
		}
		await paceGate(env, now);
		const verdict = await sendMail(env, mail);
		if (verdict.state === 'throttled') {
			await env.DB.prepare("UPDATE source_suggestion_outbox SET state='pending',lease_until=?,attempts=MAX(attempts-1,0) WHERE id=?").bind(verdict.retryAt, row.id).run();
			deferred += rows.results.length - i;
			break;
		}
		if (verdict.state === 'sent') {
			const scrub = row.kind === 'confirm' ? ",payload='{}'" : '';
			await env.DB.prepare(`UPDATE source_suggestion_outbox SET state='sent',sent_at=?,provider_ref=?${scrub} WHERE id=?`).bind(Date.now(), verdict.ref, row.id).run();
			sent++;
		} else if (verdict.state === 'rejected') {
			await env.DB.prepare("UPDATE source_suggestion_outbox SET state='failed' WHERE id=?").bind(row.id).run();
			failed++;
		} else {
			await env.DB.prepare("UPDATE source_suggestion_outbox SET state='uncertain',attempt_at=? WHERE id=?").bind(now, row.id).run();
			deferred++;
		}
	}
	return { sent, failed, deferred };
}

/** Renders the stored payload with everything the mail needs. All interpolation is escaped;
 * subject text is reduced to one line and carries the opaque attribution reference. The owner
 * notice renders only sanitized text — never raw, unescaped HTML. */
function renderSuggestionEmail(row: OutboxRow): { to: string; subject: string; text: string; html: string } | undefined {
	const payload = JSON.parse(row.payload) as {
		ref?: string; token?: string; kind?: string; name?: string; language?: string; target?: string; notes?: string; confirmedAt?: number;
	};
	const tag = ` [#${payload.ref ?? row.id.slice(0, 8)}]`;
	if (row.kind === 'confirm') {
		const token = payload.token ?? '';
		if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
		const es = payload.language !== 'en';
		const link = `${ORIGIN}${CONFIRM_PATH}?token=${token}&lang=${es ? 'es' : 'en'}`;
		const subject = oneLine(es ? `Confirma tu sugerencia · news.dev.pr${tag}` : `Confirm your suggestion · news.dev.pr${tag}`);
		return {
			to: row.email, subject,
			text: (es ? 'Confirma tu sugerencia con este enlace (vence en 24 horas): ' : 'Confirm your suggestion with this link (expires in 24 hours): ') + link,
			html: `<p>${es ? 'Confirma tu sugerencia con este enlace (vence en 24 horas):' : 'Confirm your suggestion with this link (expires in 24 hours):'}</p><p><a href="${link}">${link}</a></p><p>${es ? 'Si no enviaste esta sugerencia, ignora este correo.' : 'If you did not submit this suggestion, ignore this email.'}</p>`,
		};
	}
	const kind: SuggestionKind = payload.kind === 'influencer' ? 'influencer' : 'site';
	const kindLabel = kind === 'influencer' ? 'Influencer' : 'Site';
	const name = typeof payload.name === 'string' ? payload.name : '';
	const target = typeof payload.target === 'string' ? payload.target : '';
	const notes = typeof payload.notes === 'string' ? payload.notes : '';
	const confirmedAt = typeof payload.confirmedAt === 'number' && Number.isFinite(payload.confirmedAt) ? payload.confirmedAt : row.created_at;
	const stamp = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', dateStyle: 'medium', timeStyle: 'short' }).format(confirmedAt) + ' AST';
	const iso = new Date(confirmedAt).toISOString();
	const subject = oneLine(`Confirmed source suggestion (${kindLabel.toLowerCase()}) · news.dev.pr${tag}`);
	const text = `A source suggestion was confirmed.\nKind: ${kindLabel}\nName: ${name}\nTarget: ${target}\nNotes: ${notes || '(none)'}\nConfirmed at: ${stamp} (${iso})`;
	const html = `<p>A source suggestion was confirmed.</p><p>Kind: ${escapeHtml(kindLabel)}</p><p>Name: ${escapeHtml(name)}</p><p>Target: ${escapeHtml(target)}</p><p>Notes: ${notes ? escapeHtml(notes) : '(none)'}</p><p>Confirmed at: ${escapeHtml(stamp)} (${escapeHtml(iso)})</p>`;
	return { to: row.email, subject, text, html };
}
