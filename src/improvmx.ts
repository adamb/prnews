/**
 * ImprovMX Send API (v4) client, per the official reference (https://improvmx.com/api):
 *   POST /v4/domains/:domain/emails/outbound  — basic auth "api:<key>", `from` is the local
 *   part, `to` accepts one address, `reply_to` is supported. The API classifies Alerts and
 *   Magic Links as supported transactional mail; marketing (newsletters, digests, promotions)
 *   is explicitly prohibited, which is why the daily digest stays Resend-only and disabled.
 *
 * The Send API has NO idempotency keys. Ambiguous outcomes (timeouts, connection loss, 5xx)
 * are never auto-retried by this file: callers persist an 'uncertain' outbox state and resolve
 * it through the provider's email logs (subject-reference search, exact-recipient window
 * fallback) before deciding to resend. 429 responses carry Retry-After and cost no attempt.
 * API credentials and bodies are never logged. One account shares a 10 requests/minute send
 * limit and a daily send quota with SMTP, so callers pace globally (see alerts.ts).
 */
export interface ImprovMXEnv { IMPROVMX_API_KEY?: string; ALERTS_FROM?: string; ALERTS_DOMAIN?: string }

/** Identity confirmed with the user/parent: prnews@code.pr (forwards to the owner; the
 * code.pr domain is send-ready under the existing premium account). `from` stays the bare
 * local part because the official parameter takes the local part only. */
const DEFAULT_FROM_LOCAL = 'prnews';
const DEFAULT_DOMAIN = 'code.pr';
const LOCAL_PART = /^[a-z0-9]([a-z0-9._+-]{0,62})[a-z0-9]$/;
const DOMAIN_PART = /^[a-z0-9.-]{1,253}$/;

export interface Sender {
	from: string;
	domain: string;
	address: string;
	/** reply_to the same confirmed contact address the user/parent designated. */
	replyTo: string;
}
export function alertsSender(env: ImprovMXEnv): Sender | undefined {
	const key = env.IMPROVMX_API_KEY?.trim();
	if (!key) return undefined;
	const from = (env.ALERTS_FROM?.trim().toLowerCase() || DEFAULT_FROM_LOCAL);
	const domain = (env.ALERTS_DOMAIN?.trim().toLowerCase() || DEFAULT_DOMAIN);
	if (!LOCAL_PART.test(from) || !DOMAIN_PART.test(domain) || !domain.includes('.')) return undefined;
	return { from, domain, address: `${from}@${domain}`, replyTo: `${from}@${domain}` };
}

const SEND_TIMEOUT = 15000;
export type SendState = 'sent' | 'uncertain' | 'throttled' | 'rejected';
export interface SendResult { state: SendState; ref: string | null; retryAt: number }

function retryAfter(headers: Headers, fallback: number): number {
	const header = headers.get('Retry-After');
	if (header) {
		if (/^\d+$/.test(header)) return Date.now() + Number(header) * 1000;
		const parsed = Date.parse(header);
		if (Number.isFinite(parsed) && parsed > Date.now()) return parsed;
	}
	const reset = headers.get('X-RateLimit-Reset');
	if (reset && /^\d+$/.test(reset)) {
		const at = Number(reset) * 1000;
		if (at > Date.now()) return at;
	}
	return Date.now() + fallback;
}

/** One send. Never throws: every transport failure becomes an 'uncertain' verdict so the
 * caller can park the row and resolve acceptance through the email logs. */
export async function sendMail(env: ImprovMXEnv, mail: {
	to: string; subject: string; text: string; html: string;
}): Promise<SendResult> {
	const sender = alertsSender(env);
	if (!sender) return { state: 'rejected', ref: null, retryAt: 0 };
	try {
		const response = await fetch(`https://api.improvmx.com/v4/domains/${sender.domain}/emails/outbound`, {
			method: 'POST',
			signal: AbortSignal.timeout(SEND_TIMEOUT),
			headers: {
				Authorization: 'Basic ' + btoa(`api:${env.IMPROVMX_API_KEY!.trim()}`),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				from: sender.from,
				to: mail.to,
				reply_to: sender.replyTo,
				subject: mail.subject,
				text: mail.text,
				html: mail.html,
			}),
		});
		const retry = response.ok ? 0 : retryAfter(response.headers, response.status === 429 ? 120000 : 300000);
		if (response.status === 429) { await response.body?.cancel(); return { state: 'throttled', ref: null, retryAt: retry }; }
		if (response.ok) {
			// Accepted. The response id is the provider log id; keep it for delivery tracking.
			let ref: string | null = null;
			try { const body = await response.json() as { id?: unknown }; if (typeof body.id === 'string') ref = body.id.slice(0, 120); }
			catch { /* Status 200 stands on its own; the ref stays null. */ }
			return { state: 'sent', ref, retryAt: 0 };
		}
		if (response.status >= 500) { await response.body?.cancel(); return { state: 'uncertain', ref: null, retryAt: 0 }; }
		// 400/401/403/404: a definite rejection — ImprovMX never accepted this request.
		await response.body?.cancel();
		return { state: 'rejected', ref: null, retryAt: 0 };
	} catch {
		// Timeout, connection loss, or DNS failure: acceptance is unknown.
		return { state: 'uncertain', ref: null, retryAt: 0 };
	}
}

/** Resolution probe for one uncertain send: did ImprovMX actually accept a message with
 * this subject reference to this recipient after `afterMs`? Returns 'present' only on
 * positive evidence; 'absent' only with clean negative evidence; 'indeterminate' otherwise.
 * Callers must treat 'absent' as the ONLY signal that permits one more send attempt. */
export async function probeAccepted(env: ImprovMXEnv, recipient: string, subjectRef: string, afterMs: number): Promise<'present' | 'absent' | 'indeterminate'> {
	const sender = alertsSender(env);
	if (!sender) return 'indeterminate';
	const auth = { Authorization: 'Basic ' + btoa(`api:${env.IMPROVMX_API_KEY!.trim()}`) };
	const base = `https://api.improvmx.com/v4/domains/${sender.domain}/logs`;
	const after = new Date(afterMs - 120000).toISOString();
	try {
		// 1) Subject-reference search: positive, targeted evidence.
		const search = await fetch(`${base}/search?limit=10&transport=api&recipient=${encodeURIComponent(recipient)}&after=${encodeURIComponent(after)}&order=created_desc&query=${encodeURIComponent(subjectRef)}`, { signal: AbortSignal.timeout(SEND_TIMEOUT), headers: auth });
		if (search.ok) {
			const data = await search.json() as { logs?: unknown[] };
			if (Array.isArray(data.logs) && data.logs.length) return 'present';
			// 2) Exact window count: every API-transported send to this recipient in the window.
			const list = await fetch(`${base}?limit=20&transport=api&recipient=${encodeURIComponent(recipient)}&after=${encodeURIComponent(after)}`, { signal: AbortSignal.timeout(SEND_TIMEOUT), headers: auth });
			if (list.ok) {
				const listed = await list.json() as { logs?: unknown[] };
				if (Array.isArray(listed.logs)) return listed.logs.length ? 'present' : 'absent';
			}
			return 'indeterminate';
		}
		// The search endpoint may be unavailable; fall back to the plain window count.
		await search.body?.cancel();
		const list = await fetch(`${base}?limit=20&transport=api&recipient=${encodeURIComponent(recipient)}&after=${encodeURIComponent(after)}`, { signal: AbortSignal.timeout(SEND_TIMEOUT), headers: auth });
		if (list.ok) {
			const listed = await list.json() as { logs?: unknown[] };
			if (Array.isArray(listed.logs)) return listed.logs.length ? 'present' : 'absent';
		}
		return 'indeterminate';
	} catch {
		return 'indeterminate';
	}
}
