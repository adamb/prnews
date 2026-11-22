import {quarantined} from './quarantine';
/**
 * Keyword alerts backend: passwordless accounts (email + one phrase per signup), per-phrase
 * watchers, hashed single-use magic tokens, scoped sessions, and a paced ImprovMX outbox.
 *
 * Guarantees implemented here (agreed flow):
 *  - Public signup/sign-in are gated by Cloudflare Turnstile; missing configuration keeps
 *    them disabled (truthful UI), never an unprotected public email endpoint.
 *  - Confirmation activates an account and stamps every watcher with a baseline watermark:
 *    only articles collected (first_seen) AND published after activation ever match, so no
 *    old stories are reported. A later-arriving translation is caught by a bounded lookback
 *    window while the per-address ledger (alert_notified) rules out duplicates — that same
 *    ledger, keyed per account, guarantees an article is mailed at most once per person even
 *    when several of their phrases match.
 *  - Deliveries batch to at most one notification per hour per address, only when something
 *    matched, with bounded items per email and bounded total volume.
 *  - ImprovMX's Send API has no idempotency keys: ambiguous outcomes become 'uncertain' and
 *    are resolved through the provider's email-log probes; only a proven 'absent' ever allows
 *    one more send. 429 responses honor Retry-After without consuming attempts and stop the
 *    batch. Sends pace globally against the account's shared 10/minute and daily quota.
 *  - The first successful confirmation of an account enqueues one operator notice through
 *    that same outbox. The notice is not a keyword match, does not include the subscriber
 *    email, and is not cancelled when that account later unsubscribes.
 *  - Tokens, emails, and provider errors are never logged. Raw tokens are never persisted
 *    in their own table; outbox rows keep only the single-use mail links they must send and
 *    are purged within a day of settling.
 */
import type { Item } from './parse';
import { safeUrl } from './parse';
import { sources } from './sources';
import { translated, needsTranslation, validTranslation, type Translation, type Language } from './i18n';
import { hash } from './importance';
import { alertsSender, sendMail, probeAccepted, type ImprovMXEnv } from './improvmx';
import { verifyTurnstile, type TurnstileEnv } from './turnstile';

export interface AlertEnv extends ImprovMXEnv, TurnstileEnv {
	DB: D1Database;
	CONTACT_EMAIL?: string;
	/** Reused only as a namespaced HMAC key for the account-unsubscribe capability. */
	DIGEST_TOKEN_SECRET?: string;
	/** Optional ops overrides; code clamps them to never pace faster or send more. */
	ALERTS_MIN_INTERVAL_MS?: string;
	ALERTS_MINUTE_CAP?: string;
	ALERTS_DAILY_SEND_CAP?: string;
}

const HOUR = 3600000, DAY = 86400000, ORIGIN = 'https://news.dev.pr';
export const ALERTS_COOKIE = 'alerts_session';
const MAX_WATCHERS = 10;
/** Re-scan lookback: catches translations that arrive after a story did. The per-address
 * dedup ledger keeps this re-scan duplicate-free; the window bounds the extra reads. */
const LOOKBACK = 12 * HOUR;
const NOTIFY_ITEMS_MAX = 10, FLUSH_ACCOUNTS = 20, SENDS_PER_RUN = 20, WATCHERS_PER_RUN = 400, CANDIDATES_MAX = 600;
/** Conservative global pacing: ImprovMX sends share one 10 requests/minute limit and a daily
 * quota with SMTP, so stay well under both (default 8/minute, 200/day; the ceilings are code
 * constants — env/test overrides can only slow this down, never send more). */
const MIN_SEND_INTERVAL_MS = 8000, MINUTE_SEND_CAP = 8, DAILY_SEND_CAP = 200;
/** Test-only pacing override; production always uses the conservative constants above. */
let paceTestOverrides: { minIntervalMs?: number; minuteCap?: number; dailyCap?: number } = {};
export function setPacingForTests(overrides: { minIntervalMs?: number; minuteCap?: number; dailyCap?: number }): void {
	paceTestOverrides = { ...paceTestOverrides, ...overrides };
}
export function resetPacingForTests(): void {
	paceTestOverrides = {};
}
const GLOBAL_SIGNUP_DAILY = 50, GLOBAL_SIGNIN_DAILY = 50, PER_ADDRESS_DAY = 3;
const CONFIRM_TTL = DAY, SIGNIN_TTL = 15 * 60000, MANAGE_TTL = 14 * DAY, SESSION_TTL = 30 * DAY;
const MAX_ATTEMPTS = 5, RESOLVE_WINDOW = DAY, PROBES_PER_RUN = 4, PROBE_GRACE = 120000;
const NOTIFY_RETENTION = 21 * DAY, MAIL_RETENTION = 7 * DAY;
/** Operator mailbox for the one-time new-account notice. Not a secret. Public pages do not print it. */
export const OWNER_SIGNUP_EMAIL = 'beguelin@gmail.com';
const OWNER_NOTICE_PREFIX = 'owner-signup:';

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export const genericMessage = {
	mail: 'Si corresponde, recibirás un correo. Revisa tu bandeja. / If eligible, an email will arrive; check your inbox.',
	processed: 'Confirmación procesada. / Confirmation processed.',
	link: 'Enlace no válido, vencido o ya usado. Solicita uno nuevo. / Link invalid, expired, or already used.',
	out: 'Baja procesada. / Unsubscribe processed.',
	unavailable: 'El servicio de alertas no está disponible temporalmente. / The alerts service is temporarily unavailable.',
} as const;

export const alertsConfigured = (env: AlertEnv) => !!alertsSender(env) && (env.DIGEST_TOKEN_SECRET?.length ?? 0) >= 32;
/** Public abuse endpoints need BOTH the mail provider and server-side Turnstile verification. */
export const publicAlertsConfigured = (env: AlertEnv) => alertsConfigured(env) && !!env.TURNSTILE_SECRET_KEY?.trim();

/** Phrases reduce to lowercase word tokens (letters/numbers, ≥2 chars, ≤8 unique tokens): the
 * 120-character input limit; punctuation separates tokens, single characters are ignored.
 * Numeric-only tokens are allowed. NFC preserves Spanish combining accents. */
export function phraseTokens(phrase: unknown): string {
	if (typeof phrase !== 'string' || phrase.length > 120) return '';
	const seen = new Set<string>();
	for (const raw of phrase.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (raw.length < 2 || raw.length > 48) continue;
		seen.add(raw);
		if (seen.size >= 8) break;
	}
	return [...seen].sort().join(' ');
}
const validEmail = (email: string) => email.length > 3 && email.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email);
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();

/** A phrase matches when every one of its tokens appears as a whole word across the original
 * headline/excerpt and the validated translated text of an article. No AI, no regex over
 * untrusted content: plain token-set membership. */
export interface MatchCandidate { item: Item; translation?: Translation | null; tokenSet?: Set<string> }
function tokensFor(candidate: MatchCandidate): Set<string> {
	if (candidate.tokenSet) return candidate.tokenSet;
	const usable = candidate.item;
	return new Set<string>([usable.title ?? '', usable.summary ?? ''].flatMap(part => part.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter(t => t.length >= 2 && t.length <= 48));
}
export function phraseMatches(watcherTokens: string, candidate: MatchCandidate): boolean {
	const usable = candidate.translation && validTranslation(candidate.item, candidate.translation) ? candidate.translation : undefined;
	const set = new Set([...tokensFor(candidate), ...(usable ? [usable.title ?? '', usable.summary ?? ''] : []).flatMap(part => part.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2 && t.length <= 48))]);
	return watcherTokens.split(' ').filter(Boolean).every(token => set.has(token));
}

async function hmacHex(env: AlertEnv, message: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.DIGEST_TOKEN_SECRET ?? ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function unsubscribeToken(env: AlertEnv, accountId: string): Promise<string> {
	return hmacHex(env, 'alerts-out:' + accountId);
}

async function dailyCount(env: AlertEnv, bucket: string, day: number, cap: number): Promise<boolean> {
	const row = await env.DB.prepare('INSERT INTO alert_limits(bucket,day,count) VALUES(?,?,1) ON CONFLICT(bucket,day) DO UPDATE SET count=count+1 WHERE count<? RETURNING count').bind(bucket, day, cap).first<{ count: number }>();
	return !!row;
}
/** Ops/test env overrides can only make pacing MORE conservative: wider gaps, smaller caps. */
const numericCeil = (value: string | undefined, floor: number) => {
	const parsed = value ? Number(value) : NaN;
	return Number.isInteger(parsed) && parsed >= floor ? parsed : floor;
};
const numericFloorCap = (value: string | undefined, cap: number) => {
	const parsed = value ? Number(value) : NaN;
	return Number.isInteger(parsed) && parsed <= cap && parsed > 0 ? parsed : cap;
};
async function perAddressCount(env: AlertEnv, accountId: string, purpose: string, since: number): Promise<number> {
	const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_tokens WHERE account_id=? AND purpose=? AND created_at>?').bind(accountId, purpose, since).first<{ n: number }>();
	return row?.n ?? 0;
}

async function createOutbox(env: AlertEnv, kind: 'confirm' | 'signin' | 'notify', accountId: string, email: string, payload: Record<string, unknown>, batchHour: number | null, now: number): Promise<string> {
	const id = crypto.randomUUID();
	const inserted = await env.DB.prepare('INSERT OR IGNORE INTO alert_outbox(id,kind,account_id,batch_hour,email,payload,state,created_at) VALUES(?,?,?,?,?,?,?,?)')
		.bind(id, kind, accountId, batchHour, email, 'pending-render', 'pending', now).run();
	if (!inserted.meta.changes) return '';
	// The outbox id doubles as the subject reference the email-log probe attributes to this
	// message across retries. It travels in the subject only and is opaque.
	const stamped = JSON.stringify({ ...payload, ref: id.slice(0, 8) });
	await env.DB.prepare('UPDATE alert_outbox SET payload=? WHERE id=?').bind(stamped, id).run();
	return id;
}
async function createToken(env: AlertEnv, accountId: string, purpose: 'confirm' | 'signin' | 'manage', ttl: number, now: number): Promise<string | null> {
	const token = randomToken();
	const inserted = await env.DB.prepare('INSERT INTO alert_tokens(id,account_id,purpose,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)')
		.bind(crypto.randomUUID(), accountId, purpose, await hash(token), now + ttl, now).run();
	return inserted.meta.changes ? token : null;
}
async function createSession(env: AlertEnv, accountId: string, now: number): Promise<{ secret: string; csrf: string; expiresAt: number } | null> {
	const secret = randomToken();
	const csrf = randomToken().slice(0, 48);
	const inserted = await env.DB.prepare('INSERT INTO alert_sessions(id,account_id,token_hash,csrf,created_at,expires_at) VALUES(?,?,?,?,?,?)')
		.bind(crypto.randomUUID(), accountId, await hash(secret), csrf, now, now + SESSION_TTL).run();
	if (!inserted.meta.changes) return null;
	await env.DB.prepare('DELETE FROM alert_sessions WHERE account_id=? AND id NOT IN (SELECT id FROM alert_sessions WHERE account_id=? ORDER BY expires_at DESC LIMIT 5)').bind(accountId, accountId).run();
	return { secret, csrf, expiresAt: now + SESSION_TTL };
}
async function activeWatchers(env: AlertEnv, accountId: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM alert_watchers WHERE account_id=? AND status='active'").bind(accountId).first<{ n: number }>();
	return (row?.n ?? 0) > 0;
}
async function watcherCount(env: AlertEnv, accountId: string): Promise<number> {
	const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_watchers WHERE account_id=?').bind(accountId).first<{ n: number }>();
	return row?.n ?? 0;
}

/* ------------------------------------------------------------------ signup / confirmation */

export type Verdict = { status: 'accepted' | 'unavailable' | 'captcha-retry' | 'invalid-email' | 'invalid-phrase' };

/** Public signup: email + one phrase + Turnstile + honeypot. Every normal-shaped input gets
 * the same generic answer once the challenge is valid — existence, throttle rules and
 * provider failures are never revealed, and nothing touches the database before
 * verification. A missing/expired/failed challenge is different: it says nothing about any
 * address (it happens before any database read or counter), so the HTTP layer answers with
 * an honest bilingual retry page instead of a fake 'accepted', and it never consumes the
 * global signup/limit counters that real visitors share. */
/** Durable, bounded daily outcome counts contain no addresses, IPs or capabilities. */
export async function subscribe(env: AlertEnv, input: {
 email: string; phrase: string; language?: string; captcha?: unknown; honeypot?: unknown; ip?: string | null;
}, now = Date.now()): Promise<Verdict> {
 let outcome = 'exception';
 try {
  const verdict = await subscribeAttempt(env, input, now);
  outcome = verdict.status;
  return verdict;
 } finally {
  try {
   await env.DB.prepare('INSERT INTO alert_limits(bucket,day,count) VALUES(?,?,1) ON CONFLICT(bucket,day) DO UPDATE SET count=count+1')
    .bind('signup-outcome:' + outcome, Math.floor(now / DAY)).run();
  } catch { console.error('alerts_outcome_write_failed'); }
 }
}

async function subscribeAttempt(env: AlertEnv, input: {
	email: string; phrase: string; language?: string; captcha?: unknown; honeypot?: unknown; ip?: string | null;
}, now = Date.now()): Promise<Verdict> {
	if (!publicAlertsConfigured(env)) return { status: 'unavailable' };
	// Verify first: the token is checked before anything reads or writes the database, and a
	// VERIFIED token overrides the honeypot (real users whose autofill fills the decoy).
	const verified = await verifyTurnstile(env, input.captcha, input.ip ?? null, 'signup');
	if (input.honeypot && !verified) { console.error('alerts_gate honeypot signup'); return { status: 'accepted' }; }
	if (input.honeypot && verified) console.error('alerts_gate honeypot-autofill-accepted signup');
	// A missing/expired/failed challenge is address-state-free: the HTTP layer answers with
	// the honest bilingual retry page, and no shared counter is consumed for dead attempts.
	if (!verified) return { status: 'captcha-retry' };
	const email = input.email.trim().toLowerCase();
	const language: Language = input.language === 'en' ? 'en' : 'es';
	const tokens = phraseTokens(input.phrase || '');
	if (!validEmail(email) || !tokens) { console.error(`alerts_gate shape signup:${!validEmail(email) ? 'email' : 'phrase'}`); return { status: !validEmail(email) ? 'invalid-email' : 'invalid-phrase' }; }
	if (!await dailyCount(env, 'signup', Math.floor(now / DAY), GLOBAL_SIGNUP_DAILY)) return { status: 'accepted' };
	const account = await env.DB.prepare('SELECT id,status,language FROM alert_accounts WHERE email=?').bind(email).first<{ id: string; status: string; language: string }>();
	if (account) {
		if (account.status === 'closed') {
			await env.DB.prepare("UPDATE alert_accounts SET status='unconfirmed',language=?,request_day=0,request_count=0 WHERE id=? AND status='closed'").bind(language, account.id).run();
			await env.DB.prepare('DELETE FROM alert_watchers WHERE account_id=?').bind(account.id).run();
			await env.DB.prepare('DELETE FROM alert_tokens WHERE account_id=?').bind(account.id).run();
			await cancelAccountMail(env, account.id);
			const mail = await enrollWatchers(env, account.id, language, tokens, input.phrase, now);
			if (mail) await tryImmediateSend(env, mail, now);
			return { status: 'accepted' };
		}
		// A repeated pending signup may correct its phrase while retaining its valid link.
		if (account.status === 'unconfirmed') {
			await env.DB.prepare("UPDATE alert_accounts SET language=?,status='unconfirmed' WHERE id=? AND status='unconfirmed'").bind(language, account.id).run();
			await env.DB.prepare('DELETE FROM alert_watchers WHERE account_id=? AND status=?').bind(account.id, 'pending').run();

			const mail = await enrollWatchers(env, account.id, language, tokens, input.phrase, now);
			if (mail) await tryImmediateSend(env, mail, now);
			return { status: 'accepted' };
		}
		// An already-active address: never re-activate anything; answer with a fresh sign-in mail.
		if (account.status === 'active') await requestSigninEmail(env, account.id, email, account.language === 'en' ? 'en' : 'es', now);
		return { status: 'accepted' };
	}
	const id = crypto.randomUUID();
	const outHash = await unsubscribeToken(env, id);
	await env.DB.prepare('INSERT INTO alert_accounts(id,email,language,status,last_notification,out_hash,created_at) VALUES(?,?,?,?,?,?,?)')
		.bind(id, email, language, 'unconfirmed', 0, outHash, now).run();
	const mail = await enrollWatchers(env, id, language, tokens, input.phrase, now);
	if (mail) await tryImmediateSend(env, mail, now);
	return { status: 'accepted' };
}

async function enrollWatchers(env: AlertEnv, accountId: string, language: Language, tokens: string, originalPhrase: string, now: number): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare('INSERT INTO alert_watchers(id,account_id,phrase,tokens,status,baseline,scan_cursor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
		.bind(id, accountId, oneLine(originalPhrase).slice(0, 120), tokens, 'pending', now, now, now, now).run();
	return requestConfirmationEmail(env, accountId, language, now);
}

/** Shared by signup and email-only sign-in recovery. Does not create, replace, or activate
 * watchers: a reader recovering an expired confirmation keeps their saved phrases. */
async function requestConfirmationEmail(env: AlertEnv, accountId: string, language: Language, now: number): Promise<string> {
	// Repeated requests preserve a usable confirmation and never send a duplicate.
	const existing = await env.DB.prepare("SELECT id FROM alert_tokens WHERE account_id=? AND purpose='confirm' AND used_at IS NULL AND expires_at>?").bind(accountId, now).first<{ id: string }>();
	if (existing) {
		const queued = await env.DB.prepare("SELECT id FROM alert_outbox WHERE account_id=? AND kind='confirm' AND state='pending' ORDER BY created_at DESC LIMIT 1").bind(accountId).first<{ id: string }>();
		return queued?.id ?? '';
	}
	// The shared outbox count bounds confirmation mail across both public entry points.
	const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM alert_outbox WHERE account_id=? AND kind='confirm' AND created_at>?").bind(accountId, now - DAY).first<{ n: number }>();
	if ((sent?.n ?? 0) >= PER_ADDRESS_DAY) return '';
	const token = await createToken(env, accountId, 'confirm', CONFIRM_TTL, now);
	if (!token) return '';
	const emailRow = await env.DB.prepare('SELECT email FROM alert_accounts WHERE id=?').bind(accountId).first<{ email: string }>();
	if (!emailRow) return '';
	return createOutbox(env, 'confirm', accountId, emailRow.email, { token, language }, null, now);
}

/** Auth mail uses the same claim and pacing path as recovery, scoped to its own row.
 * Await the bounded pacing delay so a busy eight-second slot never defers to cron. */
async function tryImmediateSend(env: AlertEnv, outboxId: string, now: number): Promise<void> {
	try { await dispatch(env, now, outboxId); }
	catch { /* Claimed rows remain available for conservative lease recovery. */ }
}

export type ConfirmResult = { status: 'confirmed'; session: { secret: string; csrf: string; expiresAt: number } } | { status: 'processed' };
/** Single-use confirmation: marks the token used, activates the account, stamps every pending
 * watcher with the activation baseline (the old-stories watermark), revokes other confirm/
 * manage tokens, and opens the My-alerts session the confirmation link leads to. */
export async function confirm(env: AlertEnv, token: string, now = Date.now()): Promise<ConfirmResult> {
	if (!/^[a-f0-9]{64}$/.test(token)) return { status: 'processed' };
	const row = await env.DB.prepare("SELECT t.id,t.account_id,a.status FROM alert_tokens t JOIN alert_accounts a ON a.id=t.account_id WHERE t.token_hash=? AND t.purpose='confirm' AND t.used_at IS NULL AND t.expires_at>?")
		.bind(await hash(token), now).first<{ id: string; account_id: string; status: string }>();
	if (!row) return { status: 'processed' };
	const claim = await env.DB.prepare('UPDATE alert_tokens SET used_at=? WHERE id=? AND used_at IS NULL').bind(now, row.id).run();
	if (!claim.meta.changes) return { status: 'processed' };
	const activated = await env.DB.prepare("UPDATE alert_accounts SET status='active' WHERE id=? AND status='unconfirmed'").bind(row.account_id).run();
	// The activation moment is the watermark: stories collected or published earlier never match.
	await env.DB.prepare("UPDATE alert_watchers SET status='active',baseline=?,scan_cursor=?,updated_at=? WHERE account_id=? AND status='pending'").bind(now, now, now, row.account_id).run();
	await env.DB.prepare("DELETE FROM alert_tokens WHERE account_id=? AND purpose IN ('confirm','manage')").bind(row.account_id).run();
	// First transition only. A later sign-in, replay, edit, or closed-account reconfirmation
	// finds the durable notice row and does not enqueue another. A notice failure still leaves
	// the account confirmed: the visitor's activation does not depend on the operator mail.
	if (Number(activated.meta?.changes ?? 0) > 0) {
		try {
			const noticeId = await recordOwnerSignup(env, row.account_id, now);
			if (noticeId) await tryImmediateSend(env, noticeId, now);
		} catch {
			console.error('alerts_owner_notice_failed');
		}
	}
	if (row.status === 'unconfirmed' && await activeWatchers(env, row.account_id)) {
		const session = await createSession(env, row.account_id, now);
		if (session) return { status: 'confirmed', session };
	}
	return { status: 'processed' };
}

/* ------------------------------------------------------------------ magic sign-in */

export async function requestSignin(env: AlertEnv, input: {
	email: string; language?: string; captcha?: unknown; honeypot?: unknown; ip?: string | null;
}, now = Date.now()): Promise<Verdict> {
	if (!publicAlertsConfigured(env)) return { status: 'unavailable' };
	// Same posture as signup: verify first, honeypot defers to a verified token.
	const verified = await verifyTurnstile(env, input.captcha, input.ip ?? null, 'signin');
	if (input.honeypot && !verified) { console.error('alerts_gate honeypot signin'); return { status: 'accepted' }; }
	if (input.honeypot && verified) console.error('alerts_gate honeypot-autofill-accepted signin');
	// Honest captcha-retry for unverified challenges; nothing about the address is implied.
	if (!verified) return { status: 'captcha-retry' };
	const email = input.email.trim().toLowerCase();
	if (!validEmail(email)) { console.error('alerts_gate shape signin:email'); return { status: 'invalid-email' }; }
	if (!await dailyCount(env, 'signin', Math.floor(now / DAY), GLOBAL_SIGNIN_DAILY)) return { status: 'accepted' };
	const account = await env.DB.prepare('SELECT id,status,language FROM alert_accounts WHERE email=?').bind(email).first<{ id: string; status: string; language: string }>();
	// The response stays identical for active, unconfirmed, closed and unknown addresses.
	if (account && account.status === 'active') await requestSigninEmail(env, account.id, email, input.language === 'en' || (input.language === undefined && account.language === 'en') ? 'en' : 'es', now);
	if (account && account.status === 'unconfirmed') {
		const pending = await env.DB.prepare("SELECT id FROM alert_watchers WHERE account_id=? AND status='pending' LIMIT 1").bind(account.id).first();
		if (pending) {
			const mail = await requestConfirmationEmail(env, account.id, input.language === 'en' || (input.language === undefined && account.language === 'en') ? 'en' : 'es', now);
			if (mail) await tryImmediateSend(env, mail, now);
		}
	}
	return { status: 'accepted' };
}
async function requestSigninEmail(env: AlertEnv, accountId: string, email: string, language: Language, now: number): Promise<void> {
	if ((await perAddressCount(env, accountId, 'signin', now - DAY)) >= PER_ADDRESS_DAY) return;
	const token = await createToken(env, accountId, 'signin', SIGNIN_TTL, now);
	if (!token) return;
	const mail = await createOutbox(env, 'signin', accountId, email, { token, language }, null, now);
	if (mail) await tryImmediateSend(env, mail, now);
}

export type MagicResult = { status: 'session'; session: { secret: string; csrf: string; expiresAt: number } } | { status: 'processed' };
/** Shared single-use redemption for 'signin' (fresh login) and 'manage' (notification emails). */
export async function useMagicLink(env: AlertEnv, token: string, purpose: 'signin' | 'manage', now = Date.now()): Promise<MagicResult> {
	if (!/^[a-f0-9]{64}$/.test(token)) return { status: 'processed' };
	const row = await env.DB.prepare("SELECT t.id,t.account_id FROM alert_tokens t JOIN alert_accounts a ON a.id=t.account_id WHERE t.token_hash=? AND t.purpose=? AND t.used_at IS NULL AND t.expires_at>? AND a.status='active'")
		.bind(await hash(token), purpose, now).first<{ id: string; account_id: string }>();
	if (!row) return { status: 'processed' };
	const claim = await env.DB.prepare('UPDATE alert_tokens SET used_at=? WHERE id=? AND used_at IS NULL').bind(now, row.id).run();
	if (!claim.meta.changes) return { status: 'processed' };
	const session = await createSession(env, row.account_id, now);
	if (!session) return { status: 'processed' };
	return { status: 'session', session };
}

/* ------------------------------------------------------------------ sessions and manage */

export interface SessionRef { id: string; account_id: string; csrf: string; email: string }
export async function sessionFromCookie(env: AlertEnv, secret: string | undefined, now = Date.now()): Promise<SessionRef | null> {
	if (!secret || secret.length > 128) return null;
	return env.DB.prepare('SELECT s.id,s.account_id,s.csrf,a.email FROM alert_sessions s JOIN alert_accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>? AND a.status=?').bind(await hash(secret), now, 'active').first<SessionRef>();
}
export async function listWatchers(env: AlertEnv, accountId: string): Promise<{ id: string; phrase: string; tokens: string; status: string; created_at: number }[]> {
	const rows = await env.DB.prepare('SELECT id,phrase,tokens,status,created_at FROM alert_watchers WHERE account_id=? ORDER BY created_at DESC, id DESC').bind(accountId).all<{ id: string; phrase: string; tokens: string; status: string; created_at: number }>();
	return rows.results;
}

/** Manage mutations — every caller must already hold the session and a valid CSRF token. */
export async function manageWatcher(env: AlertEnv, accountId: string, action: 'add' | 'edit' | 'pause' | 'resume' | 'delete' | 'pauseall', watcherId: string, phrase: string, now = Date.now(), language?: Language): Promise<'ok' | 'invalid'> {
	const tokens = phraseTokens(phrase || '');
	if (action === 'add') {
		if (!tokens || (await watcherCount(env, accountId)) >= MAX_WATCHERS) return 'invalid';
		const id = crypto.randomUUID();
		// A brand-new phrase judges only newly collected stories: watermark = now.
		await env.DB.prepare('INSERT INTO alert_watchers(id,account_id,phrase,tokens,status,baseline,scan_cursor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
			.bind(id, accountId, oneLine(phrase).slice(0, 120), tokens, 'active', now, now, now, now).run();
		if (language) await env.DB.prepare('UPDATE alert_accounts SET language=? WHERE id=?').bind(language, accountId).run();
		return 'ok';
	}
	if (action === 'edit') {
		if (!tokens) return 'invalid';
		// Editing re-words the alert: its watermark restarts so the new phrase only judges
		// newly collected stories, never the back catalogue.
		const updated = await env.DB.prepare('UPDATE alert_watchers SET phrase=?,tokens=?,baseline=?,scan_cursor=?,updated_at=? WHERE id=? AND account_id=?')
			.bind(oneLine(phrase).slice(0, 120), tokens, now, now, now, watcherId, accountId).run();
		return updated.meta.changes ? 'ok' : 'invalid';
	}
	if (action === 'pauseall') {
		await env.DB.prepare("UPDATE alert_watchers SET status='paused',updated_at=? WHERE account_id=? AND status='active'").bind(now, accountId).run();
		return 'ok';
	}
	if (action === 'delete') {
		const removed = await env.DB.prepare('DELETE FROM alert_watchers WHERE id=? AND account_id=?').bind(watcherId, accountId).run();
		return removed.meta.changes ? 'ok' : 'invalid';
	}
	const target = action === 'pause' ? 'paused' : 'active';
	const updated = await env.DB.prepare('UPDATE alert_watchers SET status=?,updated_at=? WHERE id=? AND account_id=? AND status IN (?,?)')
		.bind(target, now, watcherId, accountId, 'paused', 'active').run();
	return updated.meta.changes ? 'ok' : 'invalid';
}

/** Unsubscribe-all via the mailed capability link: closes the account, drops every watcher
 * and queued match, revokes sessions, and cancels that account's unsent subscriber mail.
 * The operator's first-confirmation notice is left in the outbox. */
export async function closeByUnsubscribeHash(env: AlertEnv, token: string): Promise<boolean> {
	const account = await env.DB.prepare('SELECT id FROM alert_accounts WHERE out_hash=?').bind(token).first<{ id: string }>();
	if (!account) return false;
	await closeAccount(env, account.id);
	return true;
}
export async function closeAccount(env: AlertEnv, accountId: string): Promise<void> {
	await env.DB.prepare('DELETE FROM alert_watchers WHERE account_id=?').bind(accountId).run();
	await env.DB.prepare('DELETE FROM alert_tokens WHERE account_id=?').bind(accountId).run();
	await env.DB.prepare('DELETE FROM alert_sessions WHERE account_id=?').bind(accountId).run();
	await cancelAccountMail(env, accountId);
	await env.DB.prepare("UPDATE alert_accounts SET status='closed' WHERE id=?").bind(accountId).run();
}
/** Subscriber unsubscribe and closed re-enrollment cancel that account's unsent mail.
 * The operator's first-confirmation notice is not that mail: it keeps its pace slot,
 * including when the account is already closed or the row is still uncertain. */
async function cancelAccountMail(env: AlertEnv, accountId: string): Promise<void> {
	await env.DB.prepare("UPDATE alert_outbox SET state='cancelled' WHERE account_id=? AND state IN ('pending','uncertain','sending') AND kind<>'owner'").bind(accountId).run();
}
/** One operator notice per account, keyed by the account id. Phrases are the watchers
 * this confirmation activated. They are not copied onto the operator's own watchers,
 * and this function does not match or enqueue keyword alerts. */
async function recordOwnerSignup(env: AlertEnv, accountId: string, confirmedAt: number): Promise<string> {
	const id = OWNER_NOTICE_PREFIX + accountId;
	const pending = await env.DB.prepare("SELECT phrase FROM alert_watchers WHERE account_id=? AND status='active' AND baseline=? ORDER BY created_at, id").bind(accountId, confirmedAt).all<{ phrase: string }>();
	const phrases = pending.results.map(row => oneLine(row.phrase).slice(0, 120)).filter(Boolean).slice(0, MAX_WATCHERS);
	const payload = JSON.stringify({
		ownerNotice: true,
		confirmedAt,
		phrases,
		ref: accountId.replace(/-/g, '').slice(0, 8),
	});
	const notice = await env.DB.prepare(`INSERT INTO alert_signup_notices(account_id, outbox_id, confirmed_at)
		SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM alert_signup_notices WHERE account_id=?)`).bind(accountId, id, confirmedAt, accountId).run();
	if (!Number(notice.meta?.changes ?? 0)) return '';
	const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO alert_outbox(id,kind,account_id,batch_hour,email,payload,state,created_at)
		VALUES(?, 'owner', ?, NULL, ?, ?, 'pending', ?)`).bind(id, accountId, OWNER_SIGNUP_EMAIL, payload, confirmedAt).run();
	return Number(inserted.meta?.changes ?? 0) ? id : '';
}
/** Public aggregate only. Active rows are confirmed alert accounts. Closed rows are
 * confirmed accounts that later unsubscribed. Unconfirmed rows are omitted. Null means
 * the read failed; callers must not present that as zero. */
export async function confirmedAlertAccountCounts(env: { DB: D1Database }): Promise<{ active: number; closed: number } | null> {
	try {
		const row = await env.DB.prepare(`SELECT
			COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END), 0) AS active,
			COALESCE(SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END), 0) AS closed
			FROM alert_accounts`).first<{ active: number | null; closed: number | null }>();
		if (!row) return { active: 0, closed: 0 };
		return { active: Number(row.active ?? 0), closed: Number(row.closed ?? 0) };
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------------ cron sweep */

export interface SweepResult { status: string; matched?: number; flushed?: number; resolved?: number; sent?: number; pending?: number }

export async function runAlertSweep(env: AlertEnv, now = Date.now()): Promise<SweepResult> {
	if (!alertsConfigured(env)) return { status: 'unavailable' };
	await prune(env, now);
	const matched = await matchAndEnqueue(env, now);
	const flushed = await flushDue(env, now);
	const resolved = await resolveUncertain(env, now);
	const sent = await dispatch(env, now);
	return { status: 'swept', matched, flushed, resolved, sent };
}

async function prune(env: AlertEnv, now: number): Promise<void> {
	await env.DB.prepare('DELETE FROM alert_tokens WHERE expires_at<?').bind(now - MAIL_RETENTION).run();
	await env.DB.prepare('DELETE FROM alert_sessions WHERE expires_at<?').bind(now - MAIL_RETENTION).run();
	await env.DB.prepare('DELETE FROM alert_notified WHERE notified_at<?').bind(now - NOTIFY_RETENTION).run();
	await env.DB.prepare('DELETE FROM alert_queue WHERE enqueued_at<?').bind(now - MAIL_RETENTION).run();
	await env.DB.prepare("DELETE FROM alert_outbox WHERE (state IN ('sent','failed','cancelled','unresolved') AND created_at<?) OR (created_at<?)").bind(now - DAY, now - 2 * DAY).run();
	await env.DB.prepare('DELETE FROM alert_limits WHERE day<?').bind(Math.floor(now / DAY) - 2).run();
}

interface WatcherRow { id: string; account_id: string; phrase: string; tokens: string; baseline: number; scan_cursor: number }
interface QueuePayload { url: string; title: string; summary: string; source: string; phrases: string[] }

interface Candidate { item: Item; translation: Translation | null; first_seen: number; tokenSet: Set<string> }

function candidateTokens(item: Item, translation: Translation | null): Set<string> {
	const words: string[] = [];
	const collect = (part: string | undefined) => { if (part) for (const token of part.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (token.length >= 2 && token.length <= 48) words.push(token); };
	collect(item.title); collect(item.summary);
	if (translation && validTranslation(item, translation)) { collect(translation.title); collect(translation.summary); }
	return new Set(words);
}
export function phraseMatchesTokens(tokens: string, candidate: { tokenSet: Set<string> }): boolean {
	return tokens.split(' ').filter(Boolean).every(token => candidate.tokenSet.has(token));
}

async function matchAndEnqueue(env: AlertEnv, now: number): Promise<number> {
	const watchers = await env.DB.prepare('SELECT w.id,w.account_id,w.phrase,w.tokens,w.baseline,w.scan_cursor FROM alert_watchers w JOIN alert_accounts a ON a.id=w.account_id WHERE w.status=? AND a.status=? ORDER BY w.scan_cursor LIMIT ?')
		.bind('active', 'active', WATCHERS_PER_RUN).all<WatcherRow>();
	if (!watchers.results.length) return 0;
	const horizon = Math.min(...watchers.results.map(w => Math.max(w.scan_cursor, w.baseline) - LOOKBACK));
	const rows = await env.DB.prepare('SELECT url,payload,translation,first_seen FROM articles WHERE first_seen>? ORDER BY first_seen LIMIT ?').bind(horizon, CANDIDATES_MAX).all<{ url: string; payload: string; translation: string | null; first_seen: number }>();
	// Tokenize each candidate once, not once per watcher.
	const complete = rows.results.length < CANDIDATES_MAX;
	const candidates: Candidate[] = rows.results.map(row => {
		const item = JSON.parse(row.payload) as Item;
		let translation: Translation | null = null;
		if (row.translation) try { translation = JSON.parse(row.translation) as Translation; } catch { /* row stays untranslated */ }
		return { item, translation, first_seen: row.first_seen, tokenSet: candidateTokens(item, translation) };
	});
	const scanLimit = complete ? Number.MAX_SAFE_INTEGER : Math.max(horizon, (candidates.at(-1)?.first_seen ?? horizon));
	let matched = 0;
	for (const watcher of watchers.results) {
		const windowStart = Math.max(watcher.scan_cursor - LOOKBACK, watcher.baseline);
		const seen = candidates.filter(c => c.first_seen <= scanLimit && c.first_seen > windowStart && c.first_seen > watcher.baseline && c.item.time > watcher.baseline);
		const newest = seen.reduce((top, c) => Math.max(top, c.first_seen), watcher.scan_cursor < windowStart ? windowStart : watcher.scan_cursor);
		if (newest > watcher.scan_cursor) await env.DB.prepare('UPDATE alert_watchers SET scan_cursor=? WHERE id=?').bind(newest, watcher.id).run();
		for (const candidate of seen) {
			if (!phraseMatchesTokens(watcher.tokens, candidate)) continue;
			if (await enqueueMatch(env, watcher.account_id, candidate.item.url, watcher.tokens, now)) matched++;
		}
	}
	return matched;
}
/** The per-address gate: the ledger insert decides whether this article may ever be mailed
 * to this person, across every alert they own, including matches rediscovered after their
 * translation arrives. Returns true only when the article becomes a NEW pending match —
 * later phrase hits for an already-queued article just record the extra phrase. */
async function enqueueMatch(env: AlertEnv, accountId: string, url: string, tokens: string, now: number): Promise<boolean> {
	const safe = safeUrl(url);
	if (!safe) return false;
	const first = await env.DB.prepare('INSERT OR IGNORE INTO alert_notified(account_id,url,notified_at) VALUES(?,?,?)').bind(accountId, url, now).run();
	if (!first.meta.changes) {
		const row = await env.DB.prepare('SELECT id,payload FROM alert_queue WHERE account_id=? AND url=?').bind(accountId, url).first<{ id: string; payload: string }>();
		if (!row) return false;
		const payload = JSON.parse(row.payload) as QueuePayload;
		if (payload.phrases.includes(tokens)) return false;
		payload.phrases = [...payload.phrases, tokens].slice(0, 8);
		await env.DB.prepare('UPDATE alert_queue SET payload=? WHERE id=?').bind(JSON.stringify(payload), row.id).run();
		return false;
	}
	const item = await env.DB.prepare("SELECT payload->>'$.title' AS title, payload->>'$.summary' AS summary, source FROM articles WHERE url=?").bind(url).first<{ title: string; summary: string; source: string }>();
	if (!item) return false;
	await env.DB.prepare('INSERT OR IGNORE INTO alert_queue(id,account_id,url,payload,enqueued_at) VALUES(?,?,?,?,?)')
		.bind(crypto.randomUUID(), accountId, url, JSON.stringify({
			url, title: (item.title ?? '').slice(0, 300), summary: (item.summary ?? '').slice(0, 300), source: item.source, phrases: [tokens],
		} satisfies QueuePayload), now).run();
	return true;
}

/** Builds one batched notification per due address and inserts its outbox row. The mail then
 * waits for the globally paced dispatcher; hourly pacing is stamped here whether or not the
 * send later succeeds, so a struggling provider never loops. */
async function flushDue(env: AlertEnv, now: number): Promise<number> {
	const due = await env.DB.prepare('SELECT q.account_id,a.email,a.language,a.last_notification FROM alert_queue q JOIN alert_accounts a ON a.id=q.account_id WHERE a.status=? GROUP BY q.account_id ORDER BY MIN(q.enqueued_at) LIMIT ?')
		.bind('active', FLUSH_ACCOUNTS).all<{ account_id: string; email: string; language: Language; last_notification: number }>();
	let flushed = 0;
	for (const row of due.results) {
		if (row.last_notification > now - HOUR) continue;
		const queued = await env.DB.prepare('SELECT url,payload FROM alert_queue WHERE account_id=? ORDER BY enqueued_at LIMIT ?').bind(row.account_id, NOTIFY_ITEMS_MAX).all<{ url: string; payload: string }>();
		if (!queued.results.length) continue;
		const candidates = queued.results.map(i => i.url);
		const stored = await env.DB.prepare(`SELECT url,payload,translation FROM articles WHERE url IN (${candidates.map(() => '?').join(',')})`).bind(...candidates).all<{ url: string; payload: string; translation: string | null }>();
		const articles = new Map(stored.results.map(r => [r.url, r]));
		const items: QueuePayload[] = [];
		for (const queuedItem of queued.results) {
			const snapshot = JSON.parse(queuedItem.payload) as QueuePayload;
			const live = articles.get(snapshot.url);
			// Missing live metadata cannot establish English eligibility for legacy snapshots.
			if (!live && row.language === 'en') continue;
			const item = live ? JSON.parse(live.payload) as Item : itemOf(snapshot);
			const cache: Record<string, Translation> = {};
			try { if (live?.translation) cache[item.url] = JSON.parse(live.translation); } catch { /* validate bundled fallback */ }
			if (row.language === 'en' && needsTranslation(item, cache)) continue;
			const localized = translated(item, row.language === 'en' ? 'en' : 'es', cache);
			items.push({ ...snapshot, title: localized.title.slice(0, 300), summary: localized.summary.slice(0, 300) });
		}
		if (!items.length) continue;
		const urls = items.map(i => i.url);
		// Fresh single-use manage link inside the notification (14-day validity, used once).
		const manageToken = await createToken(env, row.account_id, 'manage', MANAGE_TTL, now);
		const id = await createOutbox(env, 'notify', row.account_id, row.email, {
			items, language: row.language, manageToken: manageToken ?? '', outToken: await unsubscribeToken(env, row.account_id),
		}, Math.floor(now / HOUR), now);
		if (id) flushed++;
		await env.DB.prepare(`DELETE FROM alert_queue WHERE account_id=? AND url IN (${urls.map(() => '?').join(',')})`).bind(row.account_id, ...urls).run();
		await env.DB.prepare('UPDATE alert_accounts SET last_notification=? WHERE id=?').bind(now, row.account_id).run();
	}
	return flushed;
}
function itemOf(snapshot: QueuePayload): Item {
	return { title: snapshot.title, summary: snapshot.summary, url: snapshot.url, source: snapshot.source, image: '', time: 0, observed: false, section: 'otras', reason: '' } as Item;
}

interface OutboxRow { id: string; kind: 'notify' | 'confirm' | 'signin' | 'owner'; account_id: string; email: string; payload: string; attempts: number; attempt_at: number | null; created_at: number }

/** A claimed 'sending' row whose lease expired is crash recovery, as in the digest: its
 * acceptance is unknown, so it becomes 'uncertain' and resolves through provider logs. */
async function recoverSending(env: AlertEnv, now: number): Promise<void> {
	await env.DB.prepare("UPDATE alert_outbox SET state='uncertain',attempt_at=COALESCE(attempt_at,created_at) WHERE state='sending' AND lease_until<?").bind(now).run();
}
async function resolveUncertain(env: AlertEnv, now: number): Promise<number> {
	await recoverSending(env, now);
	const rows = await env.DB.prepare("SELECT id,kind,account_id,email,payload,attempts,attempt_at,created_at FROM alert_outbox WHERE state='uncertain' AND attempts<=? AND attempt_at<=? AND created_at>? LIMIT ?")
		.bind(MAX_ATTEMPTS, now - PROBE_GRACE, now - RESOLVE_WINDOW, PROBES_PER_RUN).all<OutboxRow>();
	let resolved = 0;
	for (const row of rows.results) {
		const payload = JSON.parse(row.payload) as { ref?: string };
		if (!payload.ref) {
			await env.DB.prepare("UPDATE alert_outbox SET state='unresolved' WHERE id=?").bind(row.id).run();
			continue;
		}
		const verdict = await probeAccepted(env, row.email, `#${payload.ref}`, row.attempt_at ?? row.created_at);
		if (verdict === 'present') {
			await env.DB.prepare("UPDATE alert_outbox SET state='sent',sent_at=? WHERE id=?").bind(now, row.id).run();
			resolved++;
		} else if (verdict === 'absent') {
			// The provider never accepted this message: exactly here — and only here — one
			// more send may happen, with the same payload and its same single-use links.
			if (row.attempts < MAX_ATTEMPTS) {
				await env.DB.prepare("UPDATE alert_outbox SET state='pending',lease_until=?,attempt_at=NULL WHERE id=?").bind(now + 300000, row.id).run();
			} else {
				await env.DB.prepare("UPDATE alert_outbox SET state='unresolved' WHERE id=?").bind(row.id).run();
			}
			resolved++;
		} else if (row.attempts >= MAX_ATTEMPTS || row.created_at < now - RESOLVE_WINDOW) {
			await env.DB.prepare("UPDATE alert_outbox SET state='unresolved' WHERE id=?").bind(row.id).run();
		}
	}
	return resolved;
}

async function paceGate(env: AlertEnv, now: number): Promise<void> {
	await env.DB.prepare("INSERT OR IGNORE INTO alert_pace(id,last_send,minute,minute_count) VALUES('pace',0,0,0)").run();
	const pace = await env.DB.prepare("SELECT last_send,minute,minute_count FROM alert_pace WHERE id='pace'").first<{ last_send: number; minute: number; minute_count: number }>();
	if (!pace) return;
	const minInterval = paceTestOverrides.minIntervalMs ?? numericCeil(env.ALERTS_MIN_INTERVAL_MS, MIN_SEND_INTERVAL_MS);
	const minuteCap = paceTestOverrides.minuteCap ?? numericFloorCap(env.ALERTS_MINUTE_CAP, MINUTE_SEND_CAP);
	const minute = Math.floor(now / 60000);
	let wait = 0;
	if (now - pace.last_send < minInterval) wait += minInterval - (now - pace.last_send);
	if (pace.minute === minute && pace.minute_count >= minuteCap) wait += 60000 - (now % 60000);
	if (wait > 0) await new Promise(resolve => setTimeout(resolve, Math.min(wait, 120000)));
	const stampedAt = Date.now(), stampedMinute = Math.floor(stampedAt / 60000);
	const reserved = await env.DB.prepare("UPDATE alert_pace SET last_send=?, minute_count=CASE WHEN minute=? THEN minute_count+1 ELSE 1 END, minute=CASE WHEN minute=? THEN minute ELSE ? END WHERE id='pace' AND last_send=?")
		.bind(stampedAt, stampedMinute, stampedMinute, stampedMinute, pace.last_send).run();
	if (!reserved.meta.changes) await paceGate(env, Date.now());
}

/** Globally paced, bounded dispatch of outbox rows. 'uncertain' rows are NEVER resent here;
 * they must first resolve to 'present' (stop) or 'absent' (safe to resend) through probes.
 * A 429 consumes no attempt, honors Retry-After, and stops the rest of the batch.
 * Notifications require an 'active' account. Confirm and sign-in rows mail the account
 * that still needs that link. Operator notices mail even after that account closes:
 * they are not the subscriber's delivery and unsubscribe does not cancel them. */
async function dispatch(env: AlertEnv, now: number, outboxId: string | null = null): Promise<number> {
	const dailyCap = paceTestOverrides.dailyCap ?? numericFloorCap(env.ALERTS_DAILY_SEND_CAP, DAILY_SEND_CAP);
	const rows = await env.DB.prepare("SELECT o.id,o.kind,o.account_id,o.email,o.payload,o.attempts,o.created_at FROM alert_outbox o JOIN alert_accounts a ON a.id=o.account_id WHERE o.state='pending' AND o.lease_until<=? AND o.attempts<? AND o.created_at>? AND (? IS NULL OR o.id=?) AND (o.kind IN ('confirm','signin','owner') OR a.status='active') ORDER BY o.created_at LIMIT ?")
		.bind(now, MAX_ATTEMPTS, now - RESOLVE_WINDOW, outboxId, outboxId, SENDS_PER_RUN).all<OutboxRow>();
	let sent = 0;
	for (const row of rows.results) {
		if (!(await dailyCount(env, 'send', Math.floor(now / DAY), dailyCap))) break;
		const claim = await env.DB.prepare("UPDATE alert_outbox SET state='sending',lease_until=?,attempts=attempts+1,attempt_at=COALESCE(attempt_at,?) WHERE id=? AND state='pending' AND lease_until<=? AND attempts<?")
			.bind(now + 120000, now, row.id, now, MAX_ATTEMPTS).run();
		if (!claim.meta.changes) continue;
		const mail = renderOutboxEmail(row);
		if (!mail) {
			await env.DB.prepare("UPDATE alert_outbox SET state='failed' WHERE id=?").bind(row.id).run();
			continue;
		}
		await paceGate(env, now);
		const verdict = await sendMail(env, mail);
		if (verdict.state === 'throttled') {
			await env.DB.prepare("UPDATE alert_outbox SET state='pending',lease_until=?,attempts=MAX(attempts-1,0) WHERE id=?").bind(verdict.retryAt, row.id).run();
			break;
		}
		if (verdict.state === 'sent') {
			await env.DB.prepare("UPDATE alert_outbox SET state='sent',sent_at=?,provider_ref=? WHERE id=?").bind(Date.now(), verdict.ref, row.id).run();
			sent++;
		} else if (verdict.state === 'rejected') {
			await env.DB.prepare("UPDATE alert_outbox SET state='failed' WHERE id=?").bind(row.id).run();
		} else {
			await env.DB.prepare("UPDATE alert_outbox SET state='uncertain',attempt_at=? WHERE id=?").bind(now, row.id).run();
		}
	}
	return sent;
}

/** Renders the stored payload with everything the mail needs. All interpolation is escaped;
 * subject text is reduced to one line. The subject carries the opaque attribution reference. */
function renderOutboxEmail(row: OutboxRow): { to: string; subject: string; text: string; html: string } | undefined {
	const payload = JSON.parse(row.payload) as {
		ref?: string; language?: Language; token?: string; items?: QueuePayload[]; manageToken?: string; outToken?: string;
		ownerNotice?: boolean; confirmedAt?: number; phrases?: unknown;
	};
	const tag = ` [#${payload.ref ?? row.id.slice(0, 8)}]`;
	if (row.kind === 'owner') {
		const when = typeof payload.confirmedAt === 'number' && Number.isFinite(payload.confirmedAt) ? payload.confirmedAt : row.created_at;
		const phrases = (Array.isArray(payload.phrases) ? payload.phrases : []).filter((phrase): phrase is string => typeof phrase === 'string').map(phrase => oneLine(phrase).slice(0, 120)).filter(Boolean).slice(0, MAX_WATCHERS);
		const stamp = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', dateStyle: 'medium', timeStyle: 'short' }).format(when) + ' AST';
		const iso = new Date(when).toISOString();
		const textList = phrases.length ? phrases.map(phrase => `- ${phrase}`).join('\n') : '- (none)';
		const htmlList = phrases.length ? phrases.map(phrase => `<li>${escape(phrase)}</li>`).join('') : '<li>(none)</li>';
		const subject = oneLine(`New confirmed alert account · news.dev.pr${tag}`);
		const text = `A keyword alert account was confirmed.\nConfirmed at: ${stamp} (${iso})\nInitial keywords:\n${textList}\n\nThis notice does not include the subscriber email address. It is the one notice for that account's first successful confirmation.`;
		const html = `<p>A keyword alert account was confirmed.</p><p>Confirmed at: ${escape(stamp)} (${escape(iso)})</p><p>Initial keywords:</p><ul>${htmlList}</ul><p>This notice does not include the subscriber email address. It is the one notice for that account's first successful confirmation.</p>`;
		return { to: row.email, subject, text, html };
	}
	if (row.kind === 'confirm') {
		const token = payload.token ?? '';
		if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
		const link = `${ORIGIN}/alerts/confirm?token=${token}&lang=${payload.language === 'en' ? 'en' : 'es'}`;
		const es = payload.language !== 'en';
		const subject = oneLine(es ? `Confirma tus alertas · news.dev.pr${tag}` : `Confirm your alerts · news.dev.pr${tag}`);
		return {
			to: row.email, subject,
			text: (es ? 'Activa tus alertas con este enlace (vence en 24 horas): ' : 'Activate your alerts with this link (expires in 24 hours): ') + link,
			html: `<p>${es ? 'Activa tus alertas de noticias con este enlace (vence en 24 horas):' : 'Activate your news alerts with this link (expires in 24 hours):'}</p><p><a href="${link}">${link}</a></p><p>${es ? 'Si no solicitaste esto, ignora este correo.' : 'If you did not request this, ignore this email.'}</p>`,
		};
	}
	if (row.kind === 'signin') {
		const token = payload.token ?? '';
		if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
		const link = `${ORIGIN}/alerts/in?token=${token}&lang=${payload.language === 'en' ? 'en' : 'es'}`;
		const es = payload.language !== 'en';
		const subject = oneLine(es ? `Tu enlace para tus alertas · news.dev.pr${tag}` : `Your alerts link · news.dev.pr${tag}`);
		return {
			to: row.email, subject,
			text: (es ? 'Abre tus alertas con este enlace (vence en 15 minutos; funciona una sola vez): ' : 'Open your alerts with this link (expires in 15 minutes; single use): ') + link,
			html: `<p>${es ? 'Abre tus alertas con este enlace (vence en 15 minutos; funciona una sola vez):' : 'Open your alerts with this link (expires in 15 minutes; single use):'}</p><p><a href="${link}">${link}</a></p><p>${es ? 'Si no solicitaste esto, ignora este correo.' : 'If you did not request this, ignore this email.'}</p>`,
		};
	}
	const snapshots = (payload.items ?? []).filter(i => !quarantined(i.url)).slice(0, NOTIFY_ITEMS_MAX);
	if (!snapshots.length) return undefined;
	const es = payload.language !== 'en';
	const manage = payload.manageToken ? `${ORIGIN}/alerts/m?token=${payload.manageToken}&lang=${es ? 'es' : 'en'}` : `${ORIGIN}/alerts?lang=${es ? 'es' : 'en'}`;
	const out = payload.outToken ? `${ORIGIN}/alerts/out?token=${payload.outToken}&lang=${es ? 'es' : 'en'}` : `${ORIGIN}/alerts?lang=${es ? 'es' : 'en'}`;
	const keywords = [...new Set(snapshots.flatMap(i => i.phrases))].slice(0, 4);
	const itemBlocks = snapshots.map(i => `<p><strong>${escape(i.title)}</strong><br>${i.summary ? escape(i.summary) + '<br>' : ''}<em>${escape(sources.find(s => s.id === i.source)?.name ?? i.source)}</em> · <a href="${safeUrl(i.url) ?? ORIGIN}">${escape(i.url)}</a></p>`);
	const subject = oneLine(snapshots.length === 1
		? `${es ? 'Alerta' : 'Keyword alert'}: ${snapshots[0].title.slice(0, 70)} · news.dev.pr${tag}`
		: `${es ? 'Alertas' : 'Alerts'}: ${keywords.join(', ')} — ${snapshots.length} ${snapshots.length === 1 ? (es ? 'noticia' : 'story') : (es ? 'noticias' : 'stories')} · news.dev.pr${tag}`);
	const html = `<h1>${es ? 'Coincidencias con tus alertas' : 'Matches for your keyword alerts'}</h1>${keywords.length ? `<p>${es ? 'Palabras clave' : 'Keywords'}: <strong>${escape(keywords.join(', '))}</strong></p>` : ''}${itemBlocks.join('')}<hr><p><a href="${manage}">${es ? 'Administrar mis alertas (enlace de un solo uso)' : 'Manage my alerts (single-use link)'}</a></p><p><a href="${out}">${es ? 'Cancelar todas mis alertas' : 'Unsubscribe from all alerts'}</a></p><p>${es ? 'Recibes este correo porque una noticia de las últimas horas coincide con una de tus alertas. Máximo un correo por hora. news.dev.pr reúne titulares de medios de Puerto Rico y enlaza al artículo original; no enviamos boletines ni promociones.' : 'You receive this because a recent story matched one of your keyword alerts. At most one email per hour. news.dev.pr collects Puerto Rico news headlines and links to the original article; we do not send newsletters or promotions.'}</p>`;
	const text = `${es ? 'Coincidencias con tus alertas' : 'Matches for your keyword alerts'}${keywords.length ? ` (${es ? 'palabras clave' : 'keywords'}: ${keywords.join(', ')})` : ''}\n\n` + snapshots.map(i => `${i.title}\n${i.summary}\n${sources.find(s => s.id === i.source)?.name ?? i.source}\n${i.url}`).join('\n\n') + `\n\n${manage}\n${out}`;
	return { to: row.email, subject, text, html };
}
