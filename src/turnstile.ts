/** Cloudflare Turnstile server-side verification (official endpoint). Used only on the
 * public abuse endpoints — signup and magic sign-in — never on session-auth manage pages.
 * Fail-closed: a missing secret, hostname allowlist, or an invalid/mismatched token claim
 * means the request is treated as unverified; the public forms stay disabled, never left
 * unprotected. */
export interface TurnstileEnv { TURNSTILE_SECRET_KEY?: string; TURNSTILE_SITE_KEY?: string; TURNSTILE_HOSTNAMES?: string }

export const turnstileConfigured = (env: TurnstileEnv) => !!env.TURNSTILE_SECRET_KEY?.trim();

/** Hostname allowlist parsed from the comma-separated var; compared with siteverify's
 * lowercased hostname claim, so a token minted on any other domain is rejected. */
export function turnstileFrontends(env: TurnstileEnv): string[] {
	return (env.TURNSTILE_HOSTNAMES ?? '')
		.split(',')
		.map(h => h.trim().toLowerCase())
		.filter(Boolean);
}

/** A surface offers the widget only with the full triangle: secret (checks), site key
 * (render) and the hostname allowlist (claim check). Missing any piece pauses the forms. */
export const turnstileRenderConfigured = (env: TurnstileEnv) =>
	turnstileConfigured(env) && !!env.TURNSTILE_SITE_KEY?.trim() && turnstileFrontends(env).length > 0;

export async function verifyTurnstile(env: TurnstileEnv, token: unknown, ip: string | null, action: string, timeout = 10000): Promise<boolean> {
	/** Bounded failure diagnostics: never includes the token, the secret, or any address.
	 * Only provider error-codes and the claimed action/hostname strings appear. */
	const reject = (reason: string): false => { console.error('turnstile_reject', reason); return false; };
	const secret = env.TURNSTILE_SECRET_KEY?.trim();
	if (!secret || typeof token !== 'string' || !token || token.length > 2048) return reject(`no-token(len=${typeof token === 'string' ? token.length : 'na'})`);
	const frontends = turnstileFrontends(env);
	if (!frontends.length) return reject('no-hostname-allowlist');
	try {
		const body = new URLSearchParams({ secret, response: token });
		if (ip) body.set('remoteip', ip.slice(0, 45));
		const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
			signal: AbortSignal.timeout(timeout),
		});
		if (!response.ok) { await response.body?.cancel(); return reject(`http-${response.status}`); }
		const data = await response.json() as { success?: boolean; action?: unknown; hostname?: unknown; 'error-codes'?: unknown };
		// Canonical siteverify checks: success, the expected surface action, and an
		// allowlisted frontend hostname. Any mismatch is treated as unverified.
		if (data.success !== true) {
			const codes = Array.isArray(data['error-codes']) ? data['error-codes'].map(String).join(',') : 'none';
			return reject(`success-false(${codes})`);
		}
		if (typeof data.action !== 'string' || data.action !== action) return reject(`action-claimed=${typeof data.action === 'string' ? data.action : 'absent'} expected=${action}`);
		const claimed = typeof data.hostname === 'string' ? data.hostname.toLowerCase() : 'absent';
		if (!frontends.includes(claimed)) return reject(`hostname-claimed=${claimed} expected=${frontends.join(',')}`);
		return true;
	} catch {
		// Verification unavailable or timed out: treat as unverified. The caller keeps
		// responding generically, so the visitor may simply retry.
		return reject('network-error');
	}
}

/* ------------------------------------------------------------------ client widget */
/** Shared client-side guard for the public Turnstile forms (signup, magic sign-in, and the
 * honest captcha-retry page). Product contract, no-JS-safe:
 *  - The form is not submitted without a live token: pressing send against a missing,
 *    expired or failed challenge cancels the request, resets the widget for a fresh one,
 *    and announces guidance in an aria-live status region (the old UI silently posted dead
 *    tokens and the server answered with a generic fake success, so visitors waited for
 *    mail that never came).
 *  - If api.js never loads (blocked network, old browser), the form submits natively and the
 *    server-side verification answers with its own honest retry page — the fallback is kept.
 *  - Callbacks are wired through data attributes; on 'expired' the response field is cleared
 *    and the widget resets; on 'error' the widget resets only on the user's next send so a
 *    persistent provider error cannot loop re-renders. */
export const turnstileClientScript = `(function(){
'use strict';
var M={
ok:{es:'Verificación completada. Ya puedes enviar.',en:'Verification complete. You can submit now.'},
miss:{es:'Falta completar la verificación de seguridad: complétala y vuelve a enviar.',en:'The security verification is not complete: finish it and submit again.'},
exp:{es:'La verificación de seguridad venció: complétala otra vez y envía.',en:'The security verification expired: complete it again and submit.'},
err:{es:'La verificación de seguridad falló. Vuelve a intentarlo; si persiste, prueba otra red o navegador.',en:'The security verification failed. Try again; if it persists, try another network or browser.'}};
var ES=((((document.documentElement||{}).lang)||'es')+'').slice(0,2).toLowerCase()!=='en';
function msg(k){return ES?M[k].es:M[k].en;}
function init(form){
var box=form.querySelector('.cf-turnstile');
if(!box)return;
var status=form.querySelector('.cf-status');
if(!status){status=document.createElement('p');status.className='cf-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.setAttribute('tabindex','-1');status.hidden=true;box.parentNode.insertBefore(status,box.nextSibling);}
var last='';
var field=function(){return form.querySelector('input[name="cf-turnstile-response"]');};
var say=function(text){if(text){status.textContent=text;status.hidden=false;try{status.focus({preventScroll:true});}catch(e){try{status.focus();}catch(e2){}}}else{status.hidden=true;status.textContent='';}};
var clearField=function(){var f=field();if(f)f.value='';};
var reset=function(){clearField();try{if(window.turnstile)window.turnstile.reset(box);}catch(e){}};
window.__prTsOk=function(){last='';say(msg('ok'));};
window.__prTsExp=function(){last='exp';reset();say(msg('exp'));};
window.__prTsErr=function(){last='err';clearField();say(msg('err'));};
form.addEventListener('submit',function(e){
var f=field(),token=f&&f.value;
if(!window.turnstile||token)return;
if(e.preventDefault)e.preventDefault();
say(msg(last==='err'?'err':last==='exp'?'exp':'miss'));
if(last==='err'){reset();last='';}
});
}
var forms=document.querySelectorAll('form');
for(var i=0;i<forms.length;i++)init(forms[i]);
})();`;

/** Exact SHA-256 of `turnstileClientScript`, base64. The /alerts pages allow no inline
 * scripts beyond the widget host in their CSP, so the guard rides in via this hash; the
 * main /signup page carries no script CSP. */
export const turnstileClientScriptHash = '3OgdkY539YvKvLUCkQ3ye+cnpOMoOVAzvWPOcIV8pUU=';

/** CSP script-source fragment that admits exactly this guard script. */
export const turnstileCspSource = `'sha256-${turnstileClientScriptHash}'`;

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Widget markup + api.js + the shared guard script, with the per-surface action claim. */
export function turnstileWidget(siteKey: string, action: string): string {
	return `<div class="cf-turnstile" data-sitekey="${escape(siteKey)}" data-action="${escape(action)}" data-callback="__prTsOk" data-expired-callback="__prTsExp" data-error-callback="__prTsErr"></div>`
		+ `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><script>${turnstileClientScript}</script>`;
}
