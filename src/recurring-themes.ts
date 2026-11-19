import { currentItem } from './current-item';
import { englishSections, type Language } from './i18n';
import type { Item } from './parse';
import { COMPARE_WINDOW_MS } from './source-compare';
import { fold, navigationSections, primarySection } from './sections';
import { sources } from './sources';

/** How many example headlines to show for one theme. */
export const THEME_EXAMPLE_CAP = 3;

export interface RecurringTheme {
  id: string;
  es: string;
  en: string;
  /** Shown to the reader. Matching uses `pattern` on the folded headline and excerpt. */
  phrases: string[];
  pattern: string;
}

/**
 * A short phrase list, not the section taxonomy. A hit needs the whole phrase.
 * Spanish and English phrases sit in one group so either original counts, once.
 */
export const recurringThemes: RecurringTheme[] = [
  {
    id: 'electricidad',
    es: 'Electricidad',
    en: 'Electricity',
    phrases: ['LUMA', 'AEE', 'apagón', 'energía eléctrica', 'corte de luz', 'power outage', 'electrical grid', 'relevo de carga', 'Genera PR'],
    pattern: 'luma|aee|apagones?|energia electrica|red electrica|corte de luz|servicio electrico|power outages?|electrical grids?|load shedding|relevo de carga|genera pr|blackouts?',
  },
  {
    id: 'educacion-publica',
    es: 'Educación pública',
    en: 'Public education',
    phrases: ['Departamento de Educación', 'escuela pública', 'secretary of education', 'personal docente', 'carrera magisterial'],
    pattern: 'departamento de educacion|secretaria de educacion|secretario de educacion|secretary of education|escuelas? publicas?|public schools?|personal docente|carrera magisterial',
  },
  {
    id: 'finanzas-publicas',
    es: 'Finanzas del gobierno',
    en: 'Government finances',
    phrases: ['Junta de Supervisión Fiscal', 'Junta de Supervisión y Administración Financiera', 'plan fiscal', 'deuda pública', 'Departamento de Hacienda', 'presupuesto general', 'presupuesto del año fiscal', 'Financial Oversight and Management Board', 'FOMB'],
    pattern: 'junta de supervision fiscal|junta de control fiscal|junta de supervision y administracion financiera|financial oversight and management board|fiscal oversight board|plan fiscal|fiscal plans?|deuda publica|public debt|departamento de hacienda|secretario de hacienda|presupuesto general|presupuesto del ano fiscal|oficina de gerencia y presupuesto|fomb',
  },
  {
    id: 'salud-publica',
    es: 'Cobertura de salud',
    en: 'Public health coverage',
    phrases: ['Plan Vital', 'Departamento de Salud', 'Medicaid', 'reforma de salud', 'department of health'],
    pattern: 'plan vital|departamento de salud|department of health|reforma de salud|medicaid|administracion de seguros de salud',
  },
  {
    id: 'agua',
    es: 'Servicio de agua',
    en: 'Water service',
    phrases: ['Autoridad de Acueductos', 'acueductos y alcantarillados', 'corte de agua', 'water outage'],
    pattern: 'autoridad de acueductos|acueductos y alcantarillados|corte de agua|water outages?|servicio de agua',
  },
];

const phraseRe = (phrase: string) => new RegExp(`\\b${fold(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
const compiled = recurringThemes.map(theme => ({
  ...theme,
  re: new RegExp(`\\b(?:${theme.pattern})\\b`, 'i'),
  phraseRes: theme.phrases.map(phrase => ({ phrase, re: phraseRe(phrase) })),
}));

/** Theme ids whose phrases occur in `text`. This does not read a translation. */
export function themesForText(text: string): string[] {
  const folded = fold(text);
  return compiled.filter(theme => theme.re.test(folded)).map(theme => theme.id);
}

export interface ThemeExample {
  url: string;
  title: string;
  source: string;
  sourceName: string;
  section: string;
  sectionEs: string;
  sectionEn: string;
  time: number;
  phrases: string[];
  also: string[];
  storyId: number | null;
}

export interface ThemeCount {
  id: string;
  es: string;
  en: string;
  phrases: string[];
  articles: number;
  examples: ThemeExample[];
}

export interface ThemeReport {
  now: number;
  windowStart: number;
  considered: number;
  overlap: number;
  themes: ThemeCount[];
}

/**
 * Unique canonical URLs inside the same 14-day window as `/comparar`.
 * The first copy of a URL wins. Archive revisions are not an input.
 * `currentItem` supplies the section label. The theme itself is the phrase group.
 */
export function buildRecurringThemes(items: Item[], now: number): ThemeReport {
  const start = now - COMPARE_WINDOW_MS;
  const seen = new Set<string>();
  const rows: { item: Item; ids: string[]; phrases: Record<string, string[]> }[] = [];
  let considered = 0;
  for (const raw of items) {
    if (!raw || typeof raw.url !== 'string' || !raw.url || seen.has(raw.url)) continue;
    if (!Number.isFinite(raw.time) || raw.time < start || raw.time > now) continue;
    if (!sources.some(source => source.id === raw.source)) continue;
    seen.add(raw.url);
    let item: Item;
    try { item = currentItem(raw); } catch { continue; }
    considered++;
    const folded = fold(`${item.title} ${item.summary}`);
    const ids: string[] = [];
    const phrases: Record<string, string[]> = {};
    for (const theme of compiled) {
      if (!theme.re.test(folded)) continue;
      ids.push(theme.id);
      phrases[theme.id] = theme.phraseRes.filter(entry => entry.re.test(folded)).map(entry => entry.phrase);
    }
    if (ids.length) rows.push({ item, ids, phrases });
  }
  const themes = compiled.map(theme => {
    const mine = rows.filter(row => row.ids.includes(theme.id))
      .sort((a, b) => b.item.time - a.item.time || a.item.url.localeCompare(b.item.url));
    const examples = mine.slice(0, THEME_EXAMPLE_CAP).map(row => {
      const section = primarySection(row.item.section);
      return {
        url: row.item.url,
        title: row.item.title,
        source: row.item.source,
        sourceName: sources.find(source => source.id === row.item.source)?.name ?? row.item.source,
        section,
        sectionEs: navigationSections.find(([id]) => id === section)?.[1] ?? section,
        sectionEn: englishSections[section] ?? section,
        time: row.item.time,
        phrases: row.phrases[theme.id] ?? [],
        also: row.ids.filter(id => id !== theme.id),
        storyId: null,
      };
    });
    return { id: theme.id, es: theme.es, en: theme.en, phrases: [...theme.phrases], articles: mine.length, examples };
  });
  return { now, windowStart: start, considered, overlap: rows.filter(row => row.ids.length > 1).length, themes };
}

/** Fills story permalinks for the examples already chosen. A failed read leaves them unset. */
export async function attachThemeStoryIds(env: { DB: D1Database }, report: ThemeReport): Promise<void> {
  const examples = report.themes.flatMap(theme => theme.examples);
  if (!examples.length) return;
  try {
    const urls = [...new Set(examples.map(example => example.url))];
    const rows = await env.DB.prepare(
      `SELECT id, url FROM story_ids WHERE url IN (${urls.map(() => '?').join(',')})`,
    ).bind(...urls).all<{ id: number; url: string }>();
    const ids = new Map(rows.results.map(row => [row.url, row.id]));
    for (const example of examples) {
      const id = ids.get(example.url);
      example.storyId = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
    }
  } catch {
    for (const example of examples) example.storyId = null;
  }
}

const esc = (value: string) => value.replace(/[&<>"']/g, character => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!
));

/**
 * Phrase-theme panel. `tracked` uses `/click` only when the example has no on-site story id.
 * Rendering does not request those URLs.
 */
export function renderRecurringThemes(report: ThemeReport, lang: Language, tracked = false): string {
  const t = (es: string, en: string) => lang === 'en' ? en : es;
  const name = (id: string) => {
    const theme = report.themes.find(row => row.id === id);
    return theme ? (lang === 'en' ? theme.en : theme.es) : id;
  };
  const cards = report.themes.map(theme => {
    const phrases = theme.phrases.map(phrase => `<li>${esc(phrase)}</li>`).join('');
    const examples = theme.examples.map(example => {
      const href = example.storyId
        ? `/story?id=${example.storyId}${lang === 'en' ? '&lang=en' : ''}`
        : tracked ? `/click?url=${encodeURIComponent(example.url)}` : example.url;
      const external = example.storyId ? '' : ' target="_blank" rel="noopener noreferrer"';
      const why = example.phrases.length
        ? t('Frases en el titular o el extracto: ', 'Phrases in the headline or excerpt: ') + example.phrases.join(', ')
        : t('Coincide con el grupo de frases de este tema.', 'It matches this theme’s phrase group.');
      const also = example.also.length
        ? ' ' + t('También entra en', 'Also counted in') + ' ' + example.also.map(name).join(', ') + '.'
        : '';
      const section = lang === 'en' ? example.sectionEn : example.sectionEs;
      return `<li class="theme-example"><a href="${esc(href)}"${external}>${esc(example.title)}</a><p class="theme-meta">${esc(example.sourceName)} · ${esc(t('Sección', 'Section'))}: ${esc(section)}</p><p class="theme-why">${esc(why + also)}</p></li>`;
    }).join('');
    const body = theme.articles
      ? `<ol class="theme-examples">${examples}</ol>`
      : `<p class="theme-empty">${t('Ningún artículo de esta ventana trae estas frases.', 'No article in this window carries these phrases.')}</p>`;
    const label = lang === 'en' ? theme.en : theme.es;
    const noun = lang === 'en' ? (theme.articles === 1 ? 'article' : 'articles') : (theme.articles === 1 ? 'artículo' : 'artículos');
    return `<article class="theme-card"><header><h3>${esc(label)}</h3><p class="theme-count"><b>${theme.articles}</b> <span>${noun}</span></p></header><ul class="theme-phrases" aria-label="${esc(t('Frases de este tema', 'Phrases for this theme'))}">${phrases}</ul>${body}</article>`;
  }).join('');
  const overlap = report.overlap
    ? t(`${report.overlap} ${report.overlap === 1 ? 'artículo coincide' : 'artículos coinciden'} con más de un tema. Esos conteos se superponen: no son una partición.`, `${report.overlap} ${report.overlap === 1 ? 'article matches' : 'articles match'} more than one theme. Those counts overlap. They are not a partition.`)
    : t('Ningún artículo de esta ventana coincide con más de un tema.', 'No article in this window matches more than one theme.');
  return `<section class="themes" id="temas-detectados" aria-labelledby="themes-heading"><div class="compare-head"><h2 id="themes-heading">${t('Temas detectados por frases', 'Themes detected by phrases')}</h2></div><p class="compare-note">${t('Esto no es la tabla de secciones de arriba. Una sección es la clasificación que muestra la página. Un tema de aquí es un grupo fijo de frases en el titular y el extracto originales. No es una tendencia, no es un modelo y no lee la traducción guardada.', 'This is not the section table above. A section is the classification the page shows. A theme here is a fixed group of phrases in the original headline and excerpt. It is not a trend, not a model, and it does not read the stored translation.')}</p><p class="compare-note">${esc(overlap)} ${t('La misma nota puede estar en dos temas. Una revisión posterior de la misma URL no se suma.', 'The same story can sit in two themes. A later revision of the same URL is not added.')}</p><div class="theme-grid">${cards}</div><details class="compare-caps"><summary>${t('Cómo se cuenta', 'How the count works')}</summary><ul class="compare-limits"><li>${t('Ventana de 14 días, la misma de este informe. Un artículo por URL canónica. El archivo de revisiones no entra.', 'The same 14-day window as this report. One article per canonical URL. Archive revisions are not included.')}</li><li>${t('El texto es el titular y el extracto guardados, en el idioma en que llegaron. Una frase en español y su equivalente en inglés cuentan el mismo artículo una sola vez. Una traducción al otro idioma no añade una coincidencia.', 'The text is the stored headline and excerpt, in the language they arrived in. A Spanish phrase and its English equivalent count the same article once. A translation into the other language does not add a hit.')}</li><li>${t('Cada frase exige la palabra completa, no un trozo dentro de otra. “Educación financiera”, “luz verde”, “el fiscal” y “escuela de samba” no entran en estos temas.', 'Each phrase needs the whole word, not a piece of another word. “Financial education,” “green light,” “the prosecutor,” and “samba school” do not enter these themes.')}</li><li>${t('La sección junto al ejemplo es la de la página, después de clasificar otra vez. Puede no ser el tema de las frases.', 'The section next to an example is the page’s section, after classification runs again. It may not be the phrase theme.')}</li><li>${t('Un ejemplo enlaza la página de esta noticia cuando existe. Si no, enlaza al medio por el redirect que ya usa el sitio. Abrir este informe no visita esos enlaces.', 'An example links to this site’s story page when one exists. Otherwise it links to the publisher through the redirect the site already uses. Opening this report does not visit those links.')}</li><li>${t('El grupo es corto a propósito. Una noticia puede hablar del tema sin estas frases, y entonces no se cuenta. No hay ranking ni proyección.', 'The set is short on purpose. A story can be about the subject without these phrases, and then it is not counted. There is no ranking and no forecast.')}</li></ul></details></section>`;
}
