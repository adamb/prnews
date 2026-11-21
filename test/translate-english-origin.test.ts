import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translated, validTranslation, validSpanishTranslation, needsTranslation, needsSpanishTranslation, type Translation } from '../src/i18n';
import { currentItem } from '../src/current-item';
import type { Item } from '../src/parse';
import { sampleQueue } from '../src/stats';
import { refresh, type Env } from '../src/ingest';
import worker from '../src/index';
import renderer from '../src/render';

const seen = Date.parse('2026-11-21T12:00:00Z');

/** A manual News is my Business import exactly as scripts/imports store it:
 * the raw URL slug title, no excerpt, and the url-slug title origin the
 * renderer corrects through currentItem(). */
const nimbImport = (title: string, url: string): Item & { titleOrigin: string } =>
 ({ url, source: 'nimb', title, summary: '', image: '', time: seen - 3600000, observed: false, section: 'negocios', reason: 'manual-import', titleOrigin: 'url-slug' } as Item & { titleOrigin: string });

const spanishEntry = (item: Item, title = 'El titular traducido del artículo publicado', summary = item.summary ? 'Resumen fiel del suceso principal.' : ''): Translation =>
 ({ target: 'es', originalTitle: item.title, originalSummary: item.summary, title, summary });

describe('English-origin items route to the reverse queue only', () => {
 const cases: [string, Item, 'reverse' | 'forward'][] = [
  ['NIMB manual import (title-only)', nimbImport('Palmas athletic club 46 4m UBS seek 46 4m consent judgment', 'https://newsismybusiness.com/palmas-ubs/'), 'reverse'],
  ['NIMB feed item with excerpt', { ...nimbImport('Palmas athletic club 46 4m UBS seek settlement', 'https://newsismybusiness.com/excerpt/'), summary: 'The parties filed a joint motion in federal court.' } as Item, 'reverse'],
  ['Pasquines default-English item', { url: 'https://pasquines.us/a/', source: 'pasquines', title: 'Puerto Rico reviews telecom rules for new construction', summary: 'The regulator opened a comment window.', image: '', time: seen - 3600000, observed: false, section: 'negocios', reason: 'test' } as Item, 'reverse'],
  ['SJDS default-English item', { url: 'https://www.sanjuandailystar.com/a/', source: 'sjds', title: 'The port authority reported record cruise arrivals', summary: 'Tourism officials said the season is the strongest yet.', image: '', time: seen - 3600000, observed: false, section: 'negocios', reason: 'test' } as Item, 'reverse'],
  ['news.pr item', { url: 'https://news.pr/story/x', source: 'newspr', title: 'The agency published the new construction rules', summary: 'The proposal affects telecom permitting islandwide.', image: '', time: seen - 3600000, observed: false, section: 'negocios', reason: 'test' } as Item, 'reverse'],
  ['Per-article English signal on a Spanish source', { url: 'https://example.org/en-signal/', source: 'noticel', title: 'Puerto Rico reviews telecom rules for new construction', summary: 'The regulator opened a comment window this week.', image: '', time: seen - 3600000, observed: false, section: 'negocios', reason: 'test', originalLanguage: 'en' } as Item, 'reverse'],
  ['Demonstrably Spanish SJDS payload', { url: 'https://www.sanjuandailystar.com/b/', source: 'sjds', title: 'El apagón afectó a miles de familias', summary: 'El servicio se restableció durante la madrugada del jueves, según la autoridad local.', image: '', time: seen - 3600000, observed: false, section: 'energia', reason: 'test', originalLanguage: 'es' } as Item, 'forward'],
  ['Demonstrably Spanish Pasquines payload', { url: 'https://pasquines.us/b/', source: 'pasquines', title: 'El apagón afectó a miles de familias del pueblo', summary: 'El servicio se restableció durante la madrugada del jueves, según la autoridad.', image: '', time: seen - 3600000, observed: false, section: 'energia', reason: 'test', originalLanguage: 'es' } as Item, 'forward'],
 ];
 it('claims reverse-direction work exactly when the item is English-origin, and never both queues', () => {
  for (const [, item, direction] of cases) {
   expect(needsSpanishTranslation(item, {})).toBe(direction === 'reverse');
   expect(needsTranslation(item, {})).toBe(direction === 'forward');
   expect(needsTranslation(item, {}) && needsSpanishTranslation(item, {})).toBe(false); // mutually exclusive per row
  }
 });
 it('never lets a Spanish-target cache leak into the English edition, and reverse-pending rows are never English-edition pending', () => {
  for (const [, item, direction] of cases) expect(needsTranslation(item, {})).toBe(direction === 'forward');
  const telecomItem = cases[2][1];
  const cache: Record<string, Translation> = { [telecomItem.url]: spanishEntry(telecomItem, 'Puerto Rico revisa las reglas', 'La regulatoria abrió una ventana.') };
  expect(translated(telecomItem, 'en', cache)).toEqual({ ...telecomItem, translated: false }); // the English edition keeps the original
  expect(needsTranslation(telecomItem, cache)).toBe(false);                                    // and the English queue never claims it
 });
});

describe('NIMB manual imports: title-only translation, honest empty excerpt', () => {
 it('accepts a title-only Spanish entry for an empty-excerpt original', () => {
  const raw = nimbImport('Puerto Ricos broadband grant 46 4m update', 'https://newsismybusiness.com/grant-46-4m/');
  expect(needsSpanishTranslation(raw, {})).toBe(true);
  expect(needsSpanishTranslation(raw, { [raw.url]: spanishEntry(raw) })).toBe(false);
 });
 it('rejects a cached entry that invents a summary the original never shipped', () => {
  const raw = nimbImport('Palmas athletic club 46 4m UBS seek 46 4m consent judgment', 'https://newsismybusiness.com/palmas-ubs/');
  expect(validSpanishTranslation(raw, { ...spanishEntry(raw), summary: 'Resumen que nunca existió en el original.' })).toBe(false);
  // The same honesty rule guards the Spanish→English direction.
  const spanishItem: Item = { url: 'https://example.org/x/', source: 'noticel', title: 'El informe de la junta de hoy', summary: '', image: '', time: seen - 3600000, observed: false, section: 'politica', reason: 'test' };
  expect(validTranslation(spanishItem, { originalTitle: spanishItem.title, originalSummary: '', title: 'The board report of the day', summary: 'A summary nobody wrote.' })).toBe(false);
 });
 it('still renders the stored translation when the renderer applies the manual slug-title correction', () => {
  // Storage keeps the raw slug as originalTitle; currentItem() displays the corrected title.
  const raw = nimbImport('Palmas athletic club 46 4m UBS seek 46 4m consent judgment', 'https://newsismybusiness.com/palmas-ubs/');
  const repaired = currentItem(raw);
  expect(repaired.title).toContain('$46.4m');
  const cache: Record<string, Translation> = { [raw.url]: spanishEntry(raw) };
  expect(validSpanishTranslation(repaired, cache[raw.url])).toBe(true);
  expect(translated(repaired, 'es', cache).translated).toBe(true);
  expect(translated(repaired, 'es', cache).title).toBe(spanishEntry(raw).title);
  // The English edition keeps the corrected English original untouched.
  expect(translated(repaired, 'en', cache)).toEqual({ ...repaired, translated: false });
 });
});

describe('Spanish edition renders cached translations for English originals; English edition keeps the original', () => {
 const item = nimbImport('Palmas athletic club 46 4m UBS seek 46 4m consent judgment', 'https://newsismybusiness.com/palmas-ubs/');
 const telecom = { url: 'https://pasquines.us/telecom/', source: 'pasquines', title: 'Puerto Rico reviews telecom rules for new construction', summary: 'The regulator opened a comment window.', image: '', time: seen - 1800000, observed: false, section: 'negocios', reason: 'test' } as Item;
 const cache: Record<string, Translation> = {
  [item.url]: spanishEntry(item, 'El club atlético Palmas y UBS buscan un fallo consentido de 46,4 millones'),
  [telecom.url]: spanishEntry(telecom, 'Puerto Rico revisa las reglas de telecomunicaciones para la nueva construcción', 'La regulatoria abrió una ventana de opiniones.'),
 };
 it('shows Spanish headlines on the Spanish homepage without any English headline or excerpt — ticker included', async () => {
  const es = await renderer.fetch(new Request('https://example.com/?lang=es'), { items: [item, telecom], translations: cache, feeds: [] } as never).text();
  expect(es).toContain('El club atlético Palmas y UBS buscan un fallo consentido de 46,4 millones');
  expect(es).toContain('Puerto Rico revisa las reglas de telecomunicaciones para la nueva construcción');
  expect(es).toContain('<p class="excerpt" lang="es">La regulatoria abrió una ventana de opiniones.</p>');
  expect(es).toContain('<span class="language">Traducido · Original en inglés</span>');
  // Nothing English from these items leaks onto the Spanish front page: card, excerpt, ticker.
  expect(es).not.toContain('Palmas athletic club');
  expect(es).not.toContain('$46.4m consent judgment');
  expect(es).not.toContain('reviews telecom rules');
  expect(es).not.toContain('The regulator opened a comment window');
 });
 it('never fabricates an excerpt for the title-only item', async () => {
  const es = await renderer.fetch(new Request('https://example.com/?lang=es'), { items: [item], translations: cache, feeds: [] } as never).text();
  expect(es).toContain('El club atlético Palmas y UBS buscan un fallo consentido de 46,4 millones');
  expect(es).not.toContain('<p class="excerpt"');   // an empty original renders with no excerpt at all
  expect(es).not.toContain('Resumen fiel');          // nothing invented, stored or displayed
 });
 it('keeps the English edition exactly on the originals', async () => {
  const en = await renderer.fetch(new Request('https://example.com/?lang=en'), { items: [item, telecom], translations: cache, feeds: [] } as never).text();
  expect(en).toContain(currentItem(item).title);          // English original, with the slug correction
  expect(en).toContain('reviews telecom rules for new construction');
  expect(en).not.toContain('El club atlético Palmas');
  expect(en).not.toContain('reglas de telecomunicaciones');
 });
});

describe('reverse queue (D1): multi-source drain, title-only storage, stats consistency', () => {
 function database(): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('migrations/0001_live.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0007_queue_history.sql', 'utf8'));
  function prepare(sql: string): any {
   let args: any[] = [];
   return { bind(...values: any[]) { args = values; return this; }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; } };
  }
  return { prepare, async batch(statements: any[]) { return Promise.all(statements.map(s => s.run())); } } as unknown as D1Database;
 }
 afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
 const insert = (DB: D1Database, item: Item, now: number, translation: string | null = null) =>
  DB.prepare('INSERT INTO articles(url,source,payload,translation,translation_attempt,first_seen,updated_at,published_at) VALUES(?,?,?,?,0,?,?,?)').bind(item.url, item.source, JSON.stringify(item), translation, now, now, item.time).run();
 /** One mock model: the Spanish prompt gets fluent Spanish output without inventing
  * summaries for empty inputs; the English prompt gets fluent English output. */
 const queueAI = () => {
  const calls: { system: string }[] = [];
  return { calls, ai: { run: async (_model: string, payload: any) => {
   const spanish = String(payload.messages[0].content).includes('fluent Spanish');
   calls.push({ system: payload.messages[0].content });
   const input = JSON.parse(payload.messages[1].content) as { id: number }[];
   return { response: JSON.stringify({ articles: input.map(e => spanish
    ? { id: e.id, title: `El titular traducido número ${e.id} del artículo`, summary: `El resumen fiel número ${e.id} del suceso publicado.` }
    : { id: e.id, title: `English headline number ${e.id} about the report`, summary: `A faithful English excerpt number ${e.id}.` }) }) };
  } } };
 };

 it('drains sjds, nimb and pasquines in one run and stores title-only rows for empty excerpts', async () => {
  const DB = database(), now = Date.parse('2026-11-21T12:00:00Z');
  const nimb = nimbImport('Palmas athletic club 46 4m UBS seek 46 4m consent judgment', 'https://newsismybusiness.com/palmas-ubs/');
  const nimbExcerpt = nimbImport('Palmas athletic club 46 4m UBS seek settlement', 'https://newsismybusiness.com/excerpt/');
  (nimbExcerpt as { summary: string }).summary = 'The parties filed a joint motion in federal court.';
  const pasquines: Item = { url: 'https://pasquines.us/a/', source: 'pasquines', title: 'Puerto Rico reviews telecom rules for new construction', summary: 'The regulator opened a comment window.', image: '', time: now - 3600000, observed: false, section: 'negocios', reason: 'test' };
  const sjdsEs: Item = { url: 'https://www.sanjuandailystar.com/b/', source: 'sjds', title: 'El apagón afectó a miles de familias', summary: 'El servicio se restableció durante la madrugada del jueves, según la autoridad local.', image: '', time: now - 3600000, observed: false, section: 'energia', reason: 'test', originalLanguage: 'es' };
  for (const row of [nimb, nimbExcerpt, pasquines, sjdsEs]) await insert(DB, row, now);
  const { calls, ai } = queueAI();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  await refresh({ DB, AI: ai } as unknown as Env);
  expect(calls.length).toBe(2); // one Spanish→English batch (the Spanish SJDS payload) and one English→Spanish batch of 3
  expect(calls.some(c => c.system.includes('fluent English'))).toBe(true);
  expect(calls.some(c => c.system.includes('fluent Spanish') && c.system.includes('empty summary'))).toBe(true);
  const rows = (await DB.prepare('SELECT payload,translation FROM articles ORDER BY url').all<{ payload: string; translation: string | null }>()).results;
  const byUrl = (url: string) => JSON.parse(rows.find(r => (JSON.parse(r.payload) as Item).url === url)!.translation!) as Translation;
  // Every English-origin row got its Spanish translation; the Spanish SJDS payload got English.
  const nimbEntry = byUrl(nimb.url);
  expect(nimbEntry.target).toBe('es');
  expect(nimbEntry.originalTitle).toBe(nimb.title);      // the raw stored headline, never rewritten
  expect(nimbEntry.originalSummary).toBe('');
  expect(nimbEntry.summary).toBe('');                    // title-only: the invented model summary was discarded with the empty original
  const excerptEntry = byUrl(nimbExcerpt.url);
  expect(excerptEntry.summary.startsWith('El resumen fiel número')).toBe(true); // an original excerpt actually ships translated
  const pasquinesEntry = byUrl(pasquines.url);
  expect(pasquinesEntry.target).toBe('es');
  const sjdsEntry = byUrl(sjdsEs.url);
  expect(sjdsEntry.target).toBeUndefined();               // the forward direction stores plain English translations
  expect(sjdsEntry.title).toContain('English headline');
  // A second run claims nothing: all four rows now render validly (caches are reused; idle runs never call AI).
  const before = calls.length;
  await refresh({ DB, AI: ai } as unknown as Env);
  expect(calls.length).toBe(before);
 });

 it('shares the 8-per-run cap fairly so one backlog cannot starve another English source', async () => {
  const DB = database(), now = Date.parse('2026-11-21T12:00:00Z');
  // Ten NIMB manual imports and two Pasquines items, all never attempted. Round-robin
  // selection must hand Pasquines a share in the very first run despite the NIMB backlog.
  const items: Item[] = Array.from({ length: 10 }, (unused, index) => nimbImport(`Palmas athletic club 46 4m update ${index}`, `https://newsismybusiness.com/palmas-${index}/`));
  const pasquines: Item[] = Array.from({ length: 2 }, (unused, index) => ({ url: `https://pasquines.us/telecom-${index}/`, source: 'pasquines', title: `Puerto Rico reviews telecom rules for new construction ${index}`, summary: 'The regulator opened a comment window.', image: '', time: now - 60000 * (index + 1), observed: false, section: 'negocios', reason: 'test' }));
  for (const item of [...items, ...pasquines]) await insert(DB, item, now);
  const { calls, ai } = queueAI();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  await refresh({ DB, AI: ai } as unknown as Env);
  expect(calls.length).toBe(2);                              // 8 items = two bounded batches of 4; the per-run cap is unchanged
  const stored = (await DB.prepare('SELECT payload FROM articles WHERE translation IS NOT NULL').all<{ payload: string }>()).results.map(r => JSON.parse(r.payload) as Item);
  expect(stored.length).toBe(8);
  expect(stored.filter(item => item.source === 'pasquines').length).toBe(2); // not blocked by the NIMB backlog
  expect(stored.filter(item => item.source === 'nimb').length).toBe(6);
 });

 it('keeps /stats queue history and /api/live on the English-edition definition while the reverse queue drains English originals', async () => {
  const DB = database(), env = { DB } as unknown as Env;
  const now = Date.parse('2026-11-21T12:00:00Z');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const spanishMissing: Item = { url: 'https://example.org/missing/', source: 'noticel', title: 'El informe de la junta de hoy', summary: 'El extracto completo de esta noticia local.', image: '', time: now - 3600000, observed: false, section: 'politica', reason: 'test' };
  const spanishCopied: Item = { ...spanishMissing, url: 'https://example.org/copied/', title: 'El titular copiado sin traducir' };
  await insert(DB, spanishMissing, now);
  await insert(DB, spanishCopied, now, JSON.stringify({ originalTitle: spanishCopied.title, originalSummary: spanishCopied.summary, title: spanishCopied.title, summary: 'Excerpt in English.' }));
  const nimb = nimbImport('Palmas athletic club 46 4m UBS seek 46 4m consent judgment', 'https://newsismybusiness.com/palmas-ubs/');
  const pasquines: Item = { ...nimb, url: 'https://pasquines.us/a/', source: 'pasquines', title: 'Puerto Rico reviews telecom rules for new construction', summary: 'The regulator opened a comment window.' } as Item;
  const sjdsEn: Item = { ...pasquines, url: 'https://www.sanjuandailystar.com/a/', source: 'sjds', title: 'The port authority reported record cruise arrivals' } as Item;
  for (const item of [nimb, pasquines, sjdsEn]) await insert(DB, item, now); // reverse-pending English rows: never English-edition pending
  await sampleQueue(env);
  const last = (await DB.prepare('SELECT pending FROM translation_queue_history ORDER BY sampled_at DESC LIMIT 1').first<any>())!;
  expect(last.pending).toBe(2); // the two Spanish rows; the English-origin rows stay out of the English-edition count
  const payload = await (await worker.fetch(new Request('https://example.com/api/live?lang=en'), env)).json() as any;
  expect(payload.pending).toBe(2);
 });
});
