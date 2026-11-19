import { currentItem } from './current-item';
import { feeds } from './ingest';
import { englishSections, type Language } from './i18n';
import type { Item } from './parse';
import { redditSource, redditTopic } from './reddit';
import { navigationSections, primarySection } from './sections';
import { sectionHue, sourceMark } from './brand';
import { sources } from './sources';

/** Active article table only. Archive revisions are a different table and are not counted. */
export const COMPARE_WINDOW_MS = 14 * 86400000;
export const COMPARE_PATH = '/comparar';
const AST = 'America/Puerto_Rico';

export interface FeedSnap { source: string; last_ok: number | null; error: string | null }
export interface ComparisonDay { key: string; partial: boolean }
export interface DayCount { count: number; observed: number; missing: boolean }
export type FeedStatus = 'paused' | 'unchecked' | 'available' | 'updating' | 'mixed';

export interface OutletReport {
  id: string;
  name: string;
  homepage: string;
  hue: number;
  total: number;
  observed: number;
  withImage: number;
  /** Null when the click ledger could not be read. Zero is a real zero. */
  clicks: number | null;
  status: FeedStatus;
  lastOk: number | null;
  topics: Record<string, number>;
  /** Reddit posts that also matched a section. Not added to newsroom topics. */
  crossTopics: Record<string, number>;
  days: DayCount[];
}

export interface Comparison {
  now: number;
  windowStart: number;
  days: ComparisonDay[];
  topics: string[];
  newsrooms: OutletReport[];
  community: OutletReport;
  unknown: number;
  clicksAvailable: boolean;
  /** Tallest newsroom day. Reddit uses its own scale and is not included. */
  maxDay: number;
}

const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: AST, year: 'numeric', month: '2-digit', day: '2-digit' });
const clock = new Intl.DateTimeFormat('en-US', { timeZone: AST, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** Calendar day in Puerto Rico, `YYYY-MM-DD`. Puerto Rico does not observe DST. */
export function astDay(ms: number): string {
  return dayKey.format(ms);
}

function midnightAST(ms: number): boolean {
  const text = clock.format(ms);
  return (text === '00:00:00' || text === '24:00:00') && ms % 1000 === 0;
}

/** AST days touched by [now-14d, now]. Today is always partial. The first day is partial unless the window opens at midnight. */
export function windowDays(now: number): ComparisonDay[] {
  const start = now - COMPARE_WINDOW_MS;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (let t = start; t <= now && keys.length < 16; t += 3600000) {
    const key = astDay(t);
    if (!seen.has(key)) { seen.add(key); keys.push(key); }
  }
  const today = astDay(now);
  if (!seen.has(today)) keys.push(today);
  const startKey = astDay(start);
  return keys.map(key => ({ key, partial: key === today || (key === startKey && !midnightAST(start)) }));
}

export const topicSlugs = navigationSections.map(([slug]) => slug).filter(slug => slug !== 'comunidad');

const configured = (id: string) => feeds[id] ?? [];

function feedStatus(id: string, snaps: FeedSnap[]): { status: FeedStatus; lastOk: number | null } {
  if (configured(id).length === 0) return { status: 'paused', lastOk: null };
  const rows = snaps.filter(row => row.source === id);
  const lastOk = rows.reduce((max, row) => row.last_ok && row.last_ok > max ? row.last_ok : max, 0);
  const healthy = rows.some(row => row.last_ok && !row.error);
  const anyError = rows.some(row => row.error);
  if (!lastOk) return { status: 'unchecked', lastOk: null };
  if (healthy && anyError) return { status: 'mixed', lastOk };
  if (healthy) return { status: 'available', lastOk };
  return { status: 'updating', lastOk };
}

/**
 * Day the outlet joined this registry, as an AST `YYYY-MM-DD`.
 * A zero before that day is not a day the newsroom published nothing.
 */
export const subscribedOn: Record<string, string> = {
  radioisla: '2026-11-19',
  walo: '2026-11-19',
};

/** A blank day is a captured zero only after a successful check that this outlet was already registered for. */
function missingDay(status: FeedStatus, count: number, key: string, since?: string): boolean {
  if (count > 0) return false;
  if (since && key < since) return true;
  return status === 'paused' || status === 'unchecked';
}

/**
 * One row per canonical URL. The first copy wins, so a repeated payload cannot
 * inflate a day. Stored `section` is not the displayed topic: `currentItem`
 * reapplies the section-page classifier, and manual imports keep their stored section.
 * Reddit stays out of the newsroom totals.
 */
export function buildComparison(items: Item[], snaps: FeedSnap[], clicks: Record<string, number> | null, now: number): Comparison {
  const days = windowDays(now);
  const start = now - COMPARE_WINDOW_MS;
  const index = new Map(days.map((day, i) => [day.key, i]));
  const seen = new Set<string>();
  const buckets = new Map<string, Item[]>();
  let unknown = 0;
  for (const raw of items) {
    if (!raw || typeof raw.url !== 'string' || !raw.url || seen.has(raw.url)) continue;
    if (!Number.isFinite(raw.time) || raw.time < start || raw.time > now) continue;
    seen.add(raw.url);
    let item: Item;
    try { item = currentItem(raw); } catch { continue; }
    if (!sources.some(source => source.id === item.source)) { unknown++; continue; }
    const list = buckets.get(item.source);
    if (list) list.push(item); else buckets.set(item.source, [item]);
  }
  const outlet = (id: string, name: string, homepage: string): OutletReport => {
    const { status, lastOk } = feedStatus(id, snaps);
    const mine = buckets.get(id) ?? [];
    const topics: Record<string, number> = {};
    const crossTopics: Record<string, number> = {};
    for (const slug of topicSlugs) { topics[slug] = 0; crossTopics[slug] = 0; }
    const series: DayCount[] = days.map(() => ({ count: 0, observed: 0, missing: false }));
    let observed = 0;
    let withImage = 0;
    for (const item of mine) {
      if (item.image) withImage++;
      if (item.observed) observed++;
      const at = index.get(astDay(item.time));
      if (at === undefined) continue;
      series[at].count++;
      if (item.observed) series[at].observed++;
      if (id === redditSource) {
        const topic = redditTopic(item.title);
        if (topic) {
          const slug = primarySection(topic);
          if (slug in crossTopics) crossTopics[slug]++;
        }
      } else {
        const slug = primarySection(item.section);
        if (slug in topics) topics[slug]++;
      }
    }
    series.forEach((day, index) => { day.missing = missingDay(status, day.count, days[index].key, subscribedOn[id]); });
    return {
      id, name, homepage, hue: sourceMark(id, name).hue, total: mine.length, observed, withImage,
      clicks: clicks ? (clicks[id] ?? 0) : null, status, lastOk, topics, crossTopics, days: series,
    };
  };
  const newsrooms = sources.filter(source => source.id !== redditSource).map(source => outlet(source.id, source.name, source.homepage));
  const communitySource = sources.find(source => source.id === redditSource)!;
  const community = outlet(communitySource.id, communitySource.name, communitySource.homepage);
  const maxDay = newsrooms.reduce((max, row) => Math.max(max, ...row.days.map(day => day.missing ? 0 : day.count)), 0);
  return { now, windowStart: start, days, topics: [...topicSlugs], newsrooms, community, unknown, clicksAvailable: clicks !== null, maxDay };
}

export async function clicksBySource(env: { DB: D1Database }, now = Date.now()): Promise<Record<string, number> | null> {
  try {
    const rows = await env.DB.prepare(
      `SELECT a.source AS source, SUM(t.clicks) AS clicks
       FROM articles a
       INNER JOIN article_click_totals t ON t.url=a.url
       WHERE a.published_at>=? AND a.published_at<=?
       GROUP BY a.source`
    ).bind(now - COMPARE_WINDOW_MS, now).all<{ source: string; clicks: number }>();
    const out: Record<string, number> = {};
    for (const row of rows.results) {
      const n = Number(row.clicks);
      if (row.source && Number.isFinite(n)) out[row.source] = n;
    }
    return out;
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const COVERAGE: Record<string, [string, string]> = {
  nimb: ['La consulta automática está pausada: el medio bloquea el acceso. Los números son enlaces importados a mano. Un día en blanco es un día sin importación, no un día en silencio.', 'Automatic fetching is paused because the publisher blocks it. Counts are links imported by hand. A blank day is a day with no import, not a silent newsroom.'],
  elvocero: ['RSS de búsqueda, 50 artículos por consulta, cada 30 minutos.', 'Search RSS, 50 items a check, every 30 minutes.'],
  noticel: ['Dos páginas del feed. No vemos lo que queda fuera de esas páginas.', 'Two feed pages. Anything past those pages is not visible here.'],
  endi: ['RSS con tope de 100 artículos por consulta.', 'RSS capped at 100 items a check.'],
  primerahora: ['RSS con tope de 100 artículos por consulta.', 'RSS capped at 100 items a check.'],
  metro: ['RSS de Arc. La dirección no fija un tamaño de página.', 'Arc RSS. The address does not set a page size.'],
  telemundo: ['RSS. La hora de publicación de este feed no se usa: cada nota queda fechada cuando la vimos.', 'RSS. This feed’s publication time is not used: every story is dated when we saw it.'],
  laperla: ['El feed del medio. El tamaño de página lo pone el feed, no nosotros.', 'The publisher’s feed. The page size is the feed’s, not one we set.'],
  sjds: ['Feed del blog. El tamaño de página lo pone el feed.', 'Blog feed. The page size is the feed’s.'],
  wapa: ['RSS de búsqueda, 50 artículos por consulta.', 'Search RSS, 50 items a check.'],
  wipr: ['El feed del medio. El tamaño de página lo pone el feed.', 'The publisher’s feed. The page size is the feed’s.'],
  claridad: ['El feed del medio. El tamaño de página lo pone el feed.', 'The publisher’s feed. The page size is the feed’s.'],
  radioisla: ['Feed registrado el 19 de noviembre de 2026. Un día anterior sin artículo capturado es un guion: todavía no lo consultábamos. Si el feed trae una nota con fecha anterior, ese día muestra el número, no un guion. Un cero a partir del 19 de noviembre es un día sin artículos capturados. El extracto sale de description y se queda en 300 caracteres.', 'Feed registered on November 19, 2026. A day before that with no captured article is a dash: we were not checking it yet. An article the feed still lists, with an earlier date, counts on that earlier day. A zero from November 19 on is a day with no captured article. The excerpt comes from description and stays at 300 characters.'],
  walo: ['Feed principal registrado el 19 de noviembre de 2026, no el feed más estrecho de Noticias. Un día anterior sin artículo capturado es un guion, no un silencio. Si el feed trae una nota con fecha anterior, ese día muestra el número. Un cero a partir del 19 de noviembre es un día sin artículos capturados.', 'Main feed registered on November 19, 2026, not the narrower Noticias feed. A day before that with no captured article is a dash, not silence. An article the feed still lists, with an earlier date, counts on that earlier day. A zero from November 19 on is a day with no captured article.'],
  reddit_puertorico: ['Las 25 publicaciones más nuevas, como máximo una vez por hora. Si ese feed falla, las 100 más nuevas de Arctic Shift. Es una comunidad, no una redacción.', 'The newest 25 posts, at most hourly. If that feed fails, the newest 100 from Arctic Shift. This is a community, not a newsroom.'],
};

function topicName(slug: string, lang: Language): string {
  if (lang === 'en') return englishSections[slug] ?? slug;
  return navigationSections.find(([id]) => id === slug)?.[1] ?? slug;
}

function dayLabel(key: string, lang: Language): string {
  const [y, m, d] = key.split('-').map(Number);
  const noon = Date.UTC(y, m - 1, d, 16, 0, 0);
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'es-PR', { timeZone: AST, day: 'numeric', month: 'short' }).format(noon);
}

function stamp(ms: number, lang: Language): string {
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'es-PR', { timeZone: AST, dateStyle: 'medium', timeStyle: 'short' }).format(ms) + ' AST';
}

function statusLine(row: OutletReport, lang: Language): string {
  const t = (es: string, en: string) => lang === 'en' ? en : es;
  const when = row.lastOk ? t('Último éxito: ', 'Last success: ') + stamp(row.lastOk, lang) : '';
  if (row.status === 'paused') return t('Consulta automática pausada.', 'Automatic fetch paused.');
  if (row.status === 'unchecked') return t('Sin consulta exitosa todavía.', 'No successful check yet.');
  if (row.status === 'mixed') return t('Una consulta está fallando. ', 'One check is failing. ') + when;
  if (row.status === 'updating') return t('Actualizando… ', 'Updating… ') + when;
  return t('Disponible. ', 'Available. ') + when;
}

function dayTip(row: OutletReport, day: ComparisonDay, cell: DayCount, lang: Language): string {
  const t = (es: string, en: string) => lang === 'en' ? en : es;
  const label = dayLabel(day.key, lang);
  if (cell.missing) {
    const since = subscribedOn[row.id];
    const before = Boolean(since && day.key < since);
    const why = before
      ? t('antes de registrar el feed, no es un cero.', 'before this feed was registered, not a zero.')
      : row.status === 'paused'
        ? t('feed pausado, no es un cero.', 'paused feed, not a zero.')
        : t('aún no hay una consulta exitosa, no es un cero.', 'no successful check yet, not a zero.');
    return `${label} · ${why}`;
  }
  const partial = day.partial ? t(' · día parcial', ' · partial day') : '';
  const seen = cell.observed ? t(` · ${cell.observed} fechadas al verlas`, ` · ${cell.observed} dated when we saw them`) : '';
  const noun = lang === 'en' ? (cell.count === 1 ? 'captured article' : 'captured articles') : (cell.count === 1 ? 'artículo capturado' : 'artículos capturados');
  return `${label} · ${cell.count} ${noun}${partial}${seen}`;
}

function chart(row: OutletReport, report: Comparison, lang: Language, scale: number): string {
  const W = 280, base = 64;
  const n = Math.max(1, report.days.length);
  const slot = W / n;
  const bw = Math.max(3, slot * 0.62);
  const bars = row.days.map((cell, i) => {
    const day = report.days[i];
    const x = i * slot + (slot - bw) / 2;
    const h = cell.missing || scale <= 0 ? 2 : Math.max(2, Math.round((cell.count / scale) * 56));
    const y = base - h;
    const kind = cell.missing ? 'miss' : day.partial ? 'partial' : cell.count === 0 ? 'zero' : 'full';
    const fill = kind === 'partial' ? `url(#hatch-${row.id})` : 'currentColor';
    return `<g class="compare-bar ${kind}" data-tip="${esc(dayTip(row, day, cell, lang))}"><rect class="hit" x="${x.toFixed(2)}" y="0" width="${bw.toFixed(2)}" height="${base}" fill="transparent"></rect><rect class="mark" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" height="${h}" fill="${fill}"></rect></g>`;
  }).join('');
  const first = report.days[0];
  const last = report.days[report.days.length - 1];
  const axis = first && last ? `<div class="compare-axis"><span>${esc(dayLabel(first.key, lang))}${first.partial ? '*' : ''}</span><span>${esc(dayLabel(last.key, lang))}${last.partial ? '*' : ''}</span></div>` : '';
  const label = lang === 'en' ? `${row.name}, captured articles per day` : `${row.name}, artículos capturados por día`;
  return `<div class="compare-chart" tabindex="0" role="group" aria-label="${esc(label)}. ${lang === 'en' ? 'Left and right arrows read one day.' : 'Las flechas leen un día.'}"><svg viewBox="0 0 ${W} ${base + 4}" aria-hidden="true"><defs><pattern id="hatch-${row.id}" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 4 L4 0" stroke="currentColor" stroke-width="1"></path></pattern></defs><line class="base" x1="0" y1="${base}" x2="${W}" y2="${base}"></line>${bars}</svg>${axis}<p class="compare-readout">${lang === 'en' ? 'Rest on a day, or use the arrows.' : 'Pasa por un día, o usa las flechas.'}</p></div>`;
}

function facts(row: OutletReport, lang: Language): string {
  const t = (es: string, en: string) => lang === 'en' ? en : es;
  const images = `${row.withImage} / ${row.total}`;
  const clicks = row.clicks === null ? t('no disponibles', 'unavailable') : String(row.clicks);
  return `<dl class="compare-meta"><div><dt>${t('Con URL de imagen', 'With an image URL')}</dt><dd>${images}</dd></div><div><dt>${t('Fechadas al verlas', 'Dated when seen')}</dt><dd>${row.observed}</dd></div><div><dt>${t('Redirecciones registradas', 'Recorded redirects')}</dt><dd>${clicks}</dd></div></dl>`;
}

function outletCard(row: OutletReport, report: Comparison, lang: Language, scale: number): string {
  const t = (es: string, en: string) => lang === 'en' ? en : es;
  return `<article class="compare-outlet" style="--h:${row.hue}" data-source="${esc(row.id)}"><header><div><h3><a href="${esc(row.homepage)}" target="_blank" rel="noopener noreferrer">${esc(row.name)}</a></h3><p class="compare-status">${esc(statusLine(row, lang))}</p></div><p class="compare-total"><b>${row.total}</b> <span>${t('capturados', 'captured')}</span></p></header>${chart(row, report, lang, scale)}${facts(row, lang)}</article>`;
}

function heatRow(row: OutletReport, report: Comparison, lang: Language): string {
  const cells = report.topics.map(slug => {
    const count = row.topics[slug] ?? 0;
    const pct = row.total ? Math.round(count / row.total * 100) : null;
    const depth = !row.total || !count ? 0 : Math.max(0.22, count / row.total).toFixed(3);
    const text = pct === null ? '—' : String(pct);
    return `<td style="--d:${depth}" data-count="${count}" data-pct="${pct ?? ''}"><span class="n-count">${count || (row.total ? '0' : '—')}</span><span class="n-pct">${row.total ? text + '%' : '—'}</span></td>`;
  }).join('');
  return `<tr style="--h:${row.hue}"><th scope="row">${esc(row.name)}</th>${cells}<td class="compare-sum"><span class="n-count">${row.total}</span><span class="n-pct">${row.total ? '100%' : '—'}</span></td></tr>`;
}

function dayTable(rows: OutletReport[], report: Comparison, lang: Language, caption: string): string {
  const head = report.days.map(day => `<th scope="col"${day.partial ? ' class="partial"' : ''}>${esc(dayLabel(day.key, lang))}${day.partial ? '*' : ''}</th>`).join('');
  const body = rows.map(row => `<tr><th scope="row">${esc(row.name)}</th>${row.days.map(cell => cell.missing ? '<td class="miss">—</td>' : `<td>${cell.count}</td>`).join('')}</tr>`).join('');
  return `<div class="compare-table-wrap"><table class="compare-table"><caption>${esc(caption)}</caption><thead><tr><th scope="col">${lang === 'en' ? 'Outlet' : 'Medio'}</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const SCRIPT = `<script>(function(){var root=document.querySelector('.compare');if(!root)return;root.querySelectorAll('.compare-mode button').forEach(function(btn){btn.addEventListener('click',function(){var mode=btn.getAttribute('data-mode')||'count';root.setAttribute('data-mode',mode);root.querySelectorAll('.compare-mode button').forEach(function(b){b.setAttribute('aria-checked',b===btn?'true':'false')})})});root.querySelectorAll('.compare-chart').forEach(function(chart){var bars=[].slice.call(chart.querySelectorAll('[data-tip]'));var out=chart.querySelector('.compare-readout');if(!bars.length||!out)return;var i=bars.length-1;function show(n){if(n<0||n>=bars.length)return;i=n;bars.forEach(function(b,j){b.classList.toggle('on',j===n)});out.textContent=bars[n].getAttribute('data-tip')||''}chart.addEventListener('mouseover',function(e){var node=e.target;var b=node&&node.closest?node.closest('[data-tip]'):null;if(b&&chart.contains(b))show(bars.indexOf(b))});chart.addEventListener('focus',function(){show(i)});chart.addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key==='ArrowLeft'||e.key==='Home'||e.key==='End'){var next=e.key==='Home'?0:e.key==='End'?bars.length-1:e.key==='ArrowRight'?Math.min(bars.length-1,i+1):Math.max(0,i-1);show(next);e.preventDefault()}})})})()</script>`;

/** Body of `/comparar`. Counts are the same in both editions; only the words change. `themesHtml` is the phrase-theme panel, built beside this report. */
export function renderComparison(report: Comparison, lang: Language, themesHtml = ''): string {
  const t = (es: string, en: string) => lang === 'en' ? en : es;
  const heads = report.topics.map(slug => `<th scope="col" style="--h:${sectionHue(slug)}">${esc(topicName(slug, lang))}</th>`).join('');
  const coverage = sources.map(source => `<li><strong>${esc(source.name)}.</strong> ${esc(COVERAGE[source.id]?.[lang === 'en' ? 1 : 0] ?? t('Feed configurado. El tamaño de página lo pone el medio.', 'Configured feed. The page size is the publisher’s.'))}</li>`).join('');
  const cross = report.topics.filter(slug => (report.community.crossTopics[slug] ?? 0) > 0).map(slug => `<li>${esc(topicName(slug, lang))}: ${report.community.crossTopics[slug]}</li>`).join('');
  const unknown = report.unknown ? `<p class="compare-note">${t(`${report.unknown} artículos capturados tienen una fuente que no está en esta lista y no entran en el informe.`, `${report.unknown} captured articles have a source that is not in this list and are left out of the report.`)}</p>` : '';
  return `<div class="compare" data-mode="count"><header class="compare-mast"><p class="compare-kicker">news.dev.pr</p><h1>${t('Qué capturamos de cada medio', 'What we captured from each outlet')}</h1><p class="compare-deck">${t('Cada cifra es un artículo que llegó por el feed y sigue en la ventana de 14 días. No es la producción del medio.', 'Each number is an article that arrived through the feed and is still inside the 14-day window. It is not that outlet’s total output.')}</p><ul class="compare-facts"><li>${t('14 días, hora de Puerto Rico', '14 days, Puerto Rico time')}</li><li>${t('Un artículo por URL canónica', 'One article per canonical URL')}</li><li>${t('El día de hoy está incompleto', 'Today is an incomplete day')}</li></ul></header><section aria-labelledby="compare-topics"><div class="compare-head"><h2 id="compare-topics">${t('Temas en lo capturado', 'Topics in the capture')}</h2><div class="compare-mode" role="radiogroup" aria-label="${t('Número en cada celda', 'Number in each cell')}"><button type="button" role="radio" aria-checked="true" data-mode="count">${t('Conteos', 'Counts')}</button><button type="button" role="radio" aria-checked="false" data-mode="pct">${t('Porcentaje', 'Percentage')}</button></div></div><p class="compare-note">${t('El color es la mezcla de ese medio, no su tamaño frente a los demás. El tema es el que muestra la sección hoy: se vuelve a clasificar al abrir la página. La sección guardada al capturar puede ser otra. Las importaciones manuales conservan la suya. Un porcentaje redondeado puede no sumar 100.', 'Color is that outlet’s own mix, not its size against the others. The topic is the one the section page shows: it is classified again when the page opens. The section stored at capture can differ. Manual imports keep theirs. Rounded percentages may not total 100.')}</p><div class="compare-heat-wrap"><table class="compare-heat"><caption>${t('Artículos capturados por medio y tema.', 'Captured articles by outlet and topic.')}</caption><thead><tr><th scope="col">${t('Medio', 'Outlet')}</th>${heads}<th scope="col">${t('Total', 'Total')}</th></tr></thead><tbody>${report.newsrooms.map(row => heatRow(row, report, lang)).join('')}</tbody></table></div></section>${themesHtml}<section aria-labelledby="compare-days"><h2 id="compare-days">${t('Artículos por día', 'Articles per day')}</h2><p class="compare-note">${t(`Cada medio tiene su gráfico. La escala es la misma: la barra más alta de las redacciones es ${report.maxDay} artículos capturados en un día. Una barra más alta es más artículos capturados, no una redacción mejor ni una cuota de la isla. El asterisco marca un día parcial. La trama es un día parcial; el guion es un día sin observación.`, `Each outlet has its own chart. The scale is shared: the tallest newsroom bar is ${report.maxDay} captured articles in a day. A taller bar is more captured articles, not a better newsroom and not a share of the island. A star marks a partial day. A hatch is a partial day; a dash is a day we did not observe.`)}</p><div class="compare-days">${report.newsrooms.map(row => outletCard(row, report, lang, report.maxDay)).join('')}</div>${dayTable(report.newsrooms, report, lang, t('Los mismos conteos que los gráficos. El asterisco es un día que la ventana de 14 días no cubre por completo.', 'The same counts as the charts. A star is a day the 14-day window does not cover completely.'))}</section><section class="compare-community" aria-labelledby="compare-community"><h2 id="compare-community">${t('Comunidad, aparte', 'Community, set apart')}</h2><p class="compare-note">${t('r/PuertoRico no es una redacción. No entra en la tabla de temas ni en la escala de los medios. Un tema de abajo es solo una coincidencia del título; la publicación sigue siendo de la comunidad.', 'r/PuertoRico is not a newsroom. It is not in the topic table or on the outlet scale. A topic below is only a title match; the post stays a community post.')}</p><div class="compare-days compare-days-one">${outletCard(report.community, report, lang, Math.max(0, ...report.community.days.map(day => day.missing ? 0 : day.count)))}</div>${cross ? `<p class="compare-note">${t('Títulos que también coincidieron con una sección:', 'Titles that also matched a section:')}</p><ul class="compare-cross">${cross}</ul>` : `<p class="compare-note">${t('Ningún título de esta ventana coincidió con otra sección.', 'No title in this window matched another section.')}</p>`}${dayTable([report.community], report, lang, t('Publicaciones de la comunidad capturadas por día.', 'Community posts captured per day.'))}</section><section aria-labelledby="compare-limits"><h2 id="compare-limits">${t('Lo que estas cifras no pueden decir', 'What these figures cannot say')}</h2><ul class="compare-limits"><li>${t('Cuántas notas publicó el medio. El feed tiene tope, y un día en cero solo dice que no capturamos ninguna.', 'How many stories the outlet published. The feed is capped, and a zero day only says we captured none.')}</li><li>${t('Nada anterior a esta ventana. El archivo guarda revisiones de titulares y no se suma aquí, para no contar dos veces la misma nota.', 'Anything before this window. The archive keeps headline revisions and is not added here, so the same story is not counted twice.')}</li><li>${t('Que un día en blanco sea un día en silencio. Si el feed está pausado o nunca respondió, ese día se muestra como un guion.', 'That a blank day was a silent day. If the feed is paused or has never succeeded, that day is a dash.')}</li><li>${t('La sección del medio, ni un ranking de calidad, sesgo o audiencia. No hay visitantes únicos ni tasa de clics.', 'The publisher’s own section, or a ranking of quality, bias, or audience. There are no unique visitors and no click-through rate.')}</li><li>${t('Los clics de correo o RSS. Esos enlaces van directo al medio. Aquí solo hay redirecciones GET de esta página, en bruto, no personas. Las de artículos que ya salieron de los 14 días no están.', 'Clicks from email or RSS. Those links go straight to the publisher. This is raw GET redirects from this site, not people. Redirects for articles that have left the 14-day window are not included.')}</li></ul>${unknown}<details class="compare-caps"><summary>${t('Tope de cada feed', 'Cap of each feed')}</summary><p>${t('El recorrido revisa las fuentes cerca de cada 15 minutos. El Vocero espera 30 minutos y Reddit, una hora.', 'The scanner checks sources about every 15 minutes. El Vocero waits 30 minutes and Reddit waits an hour.')}</p><ul>${coverage}</ul></details></section>${SCRIPT}</div>`;
}
