import * as he from 'he';

// Operator-authorized containment; this is not a verdict about phishing.
export const quarantinedDomains = ['elpostantillano.com'] as const;
export function quarantined(value: string | URL): boolean {
 try {
  const host = new URL(he.decode(String(value))).hostname.toLowerCase().replace(/\.+$/, '');
  return quarantinedDomains.some(domain => host === domain || host.endsWith('.' + domain));
 } catch { return false; }
}
export const unavailableMessage = (lang: string) => lang === 'en'
 ? 'External link unavailable while under review.'
 : 'Enlace externo no disponible mientras está bajo revisión.';

/** GET-only publisher fetch, checking every hop before making a request. */
export async function publisherFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
 let url = new URL(input);
 for (let hop = 0; hop <= 5; hop++) {
  if (quarantined(url)) throw new Error('Publisher unavailable while under review');
  const response = await fetch(url, {...init, redirect: 'manual'});
  if (![301,302,303,307,308].includes(response.status)) return response;
  const location = response.headers.get('location');
  await response.body?.cancel();
  if (!location || hop === 5) throw new Error('Publisher redirect limit');
  url = new URL(location, url);
  if (!/^https?:$/.test(url.protocol)) throw new Error('Invalid publisher redirect');
 }
 throw new Error('Publisher redirect limit');
}

/** Final boundary for composed HTML, including historical and comparison views. */
export function quarantineHtml(html: string, lang: string): string {
 return html.replace(/<a\b([^>]*?)href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi, (all, before, href, after, label) => {
  let target = he.decode(href);
  if (target.startsWith('/click?')) target = new URL(target, 'https://news.dev.pr').searchParams.get('url') ?? '';
  return quarantined(target) ? `<span>${label} <small>${unavailableMessage(lang)}</small></span>` : all;
 }).replace(/\s(?:src|content)="([^"]*)"/gi, (all, target) => quarantined(target) ? '' : all);
}
