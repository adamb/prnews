import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Item } from '../src/parse';
import renderer from '../src/render';
import {
  THEME_EXAMPLE_CAP,
  attachThemeStoryIds,
  buildRecurringThemes,
  renderRecurringThemes,
  themesForText,
  type ThemeReport,
} from '../src/recurring-themes';
import { COMPARE_WINDOW_MS } from '../src/source-compare';
import { css } from '../src/styles';

const NOW = Date.parse('2026-11-19T19:00:00Z');
const DAY = 86400000;

function item(partial: Partial<Item> & { url: string; source: string; title: string }): Item {
  return {
    summary: '',
    image: '',
    time: NOW - DAY,
    observed: false,
    section: 'otras',
    reason: 'keywords',
    ...partial,
  };
}

describe('phrase themes', () => {
  it('matches a curated phrase in either language and skips lookalikes', () => {
    expect(themesForText('Un apagón deja a LUMA y a la AEE sin margen')).toEqual(['electricidad']);
    expect(themesForText('A power outage on the electrical grid')).toEqual(['electricidad']);
    expect(themesForText('Genera PR aplicó un relevo de carga')).toEqual(['electricidad']);
    expect(themesForText('Departamento de Educación y la escuela pública')).toEqual(['educacion-publica']);
    expect(themesForText('The secretary of education visited a public school')).toEqual(['educacion-publica']);
    expect(themesForText('La Junta de Supervisión Fiscal publicó el plan fiscal')).toEqual(['finanzas-publicas']);
    expect(themesForText('The Financial Oversight and Management Board discussed public debt')).toEqual(['finanzas-publicas']);
    expect(themesForText('FOMB')).toEqual(['finanzas-publicas']);
    expect(themesForText('Plan Vital y Medicaid en el Departamento de Salud')).toEqual(['salud-publica']);
    expect(themesForText('The department of health described the reforma de salud')).toEqual(['salud-publica']);
    expect(themesForText('La Autoridad de Acueductos informó un corte de agua')).toEqual(['agua']);
    expect(themesForText('A water outage follows the acueductos y alcantarillados notice')).toEqual(['agua']);
    expect(themesForText('LUMA y la Junta de Supervisión Fiscal')).toEqual(['electricidad', 'finanzas-publicas']);

    const lookalikes = [
      'Educación financiera para la familia',
      'Financial education seminar',
      'Luz verde al proyecto',
      'A green light for the bill',
      'El fiscal del caso pidió tiempo',
      'The prosecutor asked for time',
      'Escuela de samba ensaya el sábado',
      'Samba school rehearsal',
      'AAA',
      'Los acueductos del parque',
      'La escuela abre',
      'Educación',
      'Salud',
      'El presupuesto',
      'Año fiscal',
      'The oversight board of the company met',
      'A school board vote',
      'Junta de Planificación aprueba el mapa',
      'Power and grid, said loosely',
    ];
    expect(lookalikes.filter(text => themesForText(text).length)).toEqual([]);
  });

  it('counts unique articles inside the comparison window and keeps the first copy', () => {
    const shared = 'https://www.elnuevodia.com/luma-junta/';
    const report = buildRecurringThemes([
      item({
        url: shared,
        source: 'endi',
        title: 'LUMA y la Junta de Supervisión Fiscal llegan al tribunal',
        summary: 'El juez escuchó a las partes.',
        time: NOW - DAY,
        section: 'otras',
      }),
      item({ url: shared, source: 'endi', title: 'Un apagón que no debe contarse otra vez', time: NOW - 1000 }),
      item({
        url: 'https://www.sanjuandailystar.com/health/',
        source: 'sjds',
        title: 'Department of Health defends Plan Vital and Medicaid',
        summary: 'Coverage stayed in place.',
        time: NOW - 2 * DAY,
      }),
      item({
        url: 'https://www.metro.pr/agua/',
        source: 'metro',
        title: 'Corte de agua en Ponce',
        summary: 'La Autoridad de Acueductos avisó el martes.',
        time: NOW - 3 * DAY,
      }),
      item({
        url: 'https://www.primerahora.com/educacion/',
        source: 'primerahora',
        title: 'Departamento de Educación y la carrera magisterial',
        summary: 'El calendario escolar sigue.',
        section: 'educacion',
      }),
      item({
        url: 'https://newsismybusiness.com/educacion/',
        source: 'nimb',
        title: 'Departamento de Educación anuncia becas',
        summary: 'Una nota importada.',
        section: 'deportes',
        reason: 'manual-import',
      }),
      item({
        url: 'https://www.reddit.com/r/PuertoRico/comments/abc123/outage/',
        source: 'reddit_puertorico',
        title: 'A power outage hit the neighborhood',
        summary: '',
        section: 'comunidad',
        reason: 'community',
        time: NOW - 3600000,
      }),
      item({
        url: 'https://www.elnuevodia.com/falso/',
        source: 'endi',
        title: 'Educación financiera, luz verde y el fiscal de la escuela de samba',
        summary: 'Ninguna de esas frases es uno de los temas.',
      }),
      item({
        url: 'https://www.elnuevodia.com/viejo/',
        source: 'endi',
        title: 'Un apagón fuera de la ventana',
        time: NOW - COMPARE_WINDOW_MS - 1000,
      }),
      item({
        url: 'https://www.elnuevodia.com/futuro/',
        source: 'endi',
        title: 'Un apagón futuro',
        time: NOW + DAY,
      }),
      item({ url: 'https://example.test/cpi/', source: 'cpi', title: 'Un apagón de otra fuente' }),
      item({ url: 'https://www.elnuevodia.com/nan/', source: 'endi', title: 'Un apagón sin fecha', time: Number.NaN }),
      item({ url: 'https://www.elnuevodia.com/borde/', source: 'endi', title: 'Corte de agua en el borde', time: NOW - COMPARE_WINDOW_MS }),
      item({ url: 'https://www.elnuevodia.com/ahora/', source: 'endi', title: 'Plan Vital ahora', time: NOW }),
    ], NOW);

    const count = (id: string) => report.themes.find(theme => theme.id === id)!;
    expect(report.considered).toBe(9);
    expect(report.overlap).toBe(1);
    expect(count('electricidad').articles).toBe(2);
    expect(count('finanzas-publicas').articles).toBe(1);
    expect(count('salud-publica').articles).toBe(2);
    expect(count('agua').articles).toBe(2);
    expect(count('educacion-publica').articles).toBe(2);
    expect(count('electricidad').examples.map(example => example.title)).toEqual([
      'A power outage hit the neighborhood',
      'LUMA y la Junta de Supervisión Fiscal llegan al tribunal',
    ]);
    expect(count('electricidad').examples[0].storyId).toBeNull();
    const luma = count('electricidad').examples[1];
    expect(luma.sourceName).toBe('El Nuevo Día');
    expect(luma.section).toBe('policiales');
    expect(luma.sectionEs).toBe('Seguridad y Justicia');
    expect(luma.sectionEn).toBe('Safety & Justice');
    expect(luma.phrases).toContain('LUMA');
    expect(luma.also).toEqual(['finanzas-publicas']);
    expect(count('electricidad').examples[0].section).toBe('comunidad');
    const school = count('educacion-publica').examples.find(example => example.source === 'primerahora')!;
    expect(school.section).toBe('salud');
    expect(school.sectionEs).toBe('Salud, Educación y Sociedad');
    const imported = count('educacion-publica').examples.find(example => example.source === 'nimb')!;
    expect(imported.section).toBe('deportes');
    expect(imported.sectionEs).toBe('Deportes');
    expect(count('electricidad').examples.length).toBeLessThanOrEqual(THEME_EXAMPLE_CAP);

    const secondWinsNothing = buildRecurringThemes([
      item({ url: shared, source: 'endi', title: 'Visita al parque', summary: 'Sin estas frases.' }),
      item({ url: shared, source: 'endi', title: 'Un apagón que llegó tarde', time: NOW - 1000 }),
    ], NOW);
    expect(secondWinsNothing.themes.find(theme => theme.id === 'electricidad')!.articles).toBe(0);
    expect(buildRecurringThemes([], NOW).themes.every(theme => theme.articles === 0)).toBe(true);
    expect(buildRecurringThemes([], NOW).overlap).toBe(0);
  });

  it('renders bilingual copy, escaped examples, and story links without requesting them', () => {
    const built = buildRecurringThemes([
      item({
        url: 'https://www.elnuevodia.com/luma/?a=1&b=2',
        source: 'endi',
        title: 'LUMA & <img src=x onerror=alert(1)>',
        summary: 'La Junta de Supervisión Fiscal también.',
      }),
    ], NOW);
    const withStory: ThemeReport = {
      ...built,
      themes: built.themes.map(theme => ({
        ...theme,
        examples: theme.examples.map(example => ({ ...example, storyId: example.url.includes('elnuevodia') ? 12 : null })),
      })),
    };
    const en = renderRecurringThemes(withStory, 'en', true);
    const es = renderRecurringThemes(withStory, 'es', true);
    expect(en).toContain('id="temas-detectados"');
    expect(en).toContain('aria-labelledby="themes-heading"');
    expect(en).toContain('Themes detected by phrases');
    expect(en).toContain('not a trend');
    expect(en).toContain('does not read the stored translation');
    expect(en).toContain('<details class="compare-caps">');
    expect(en).not.toMatch(/<details class="compare-caps"[^>]*\sopen[\s>]/);
    expect(en).toContain('How the count works');
    expect(en).toContain('aria-label="Phrases for this theme"');
    expect(en).toContain('href="/story?id=12&amp;lang=en"');
    expect(en).not.toContain('/click?url=');
    expect(en).not.toContain('target="_blank"');
    expect(en).not.toContain('<img src=x');
    expect(en).toContain('LUMA &amp; &lt;img src=x onerror=alert(1)&gt;');
    expect(en).toContain('Government &amp; Politics');
    expect(en).toContain('Also counted in Government finances');
    expect(es).toContain('Temas detectados por frases');
    expect(es).toContain('href="/story?id=12"');
    expect(es).not.toContain('lang=en');
    expect(es).toContain('También entra en Finanzas del gobierno');
    expect(es).toContain('Gobierno y Política');

    const untracked = renderRecurringThemes(built, 'en', false);
    expect(untracked).toContain('href="https://www.elnuevodia.com/luma/?a=1&amp;b=2"');
    expect(untracked).toContain('target="_blank" rel="noopener noreferrer"');
    expect(untracked).not.toContain('/click?url=');
    expect(untracked).not.toContain('/story?id=');

    const tracked = renderRecurringThemes(built, 'es', true);
    expect(tracked).toContain('href="/click?url=https%3A%2F%2Fwww.elnuevodia.com%2Fluma%2F%3Fa%3D1%26b%3D2"');
    expect(tracked).not.toContain('/story?id=');

    const empty = renderRecurringThemes(buildRecurringThemes([], NOW), 'en');
    expect(empty).toContain('No article in this window carries these phrases.');
    expect(empty).toContain('No article in this window matches more than one theme.');
    expect(empty).toContain('<b>0</b>');
    const emptyEs = renderRecurringThemes(buildRecurringThemes([], NOW), 'es');
    expect(emptyEs).toContain('Ningún artículo de esta ventana trae estas frases.');
    expect(emptyEs).toContain('Ningún artículo de esta ventana coincide con más de un tema.');
  });

  it('fills story ids from one story_ids read and leaves them empty when that read fails', async () => {
    const report = buildRecurringThemes([
      item({ url: 'https://www.elnuevodia.com/luma/', source: 'endi', title: 'LUMA anuncia un apagón' }),
      item({ url: 'https://www.metro.pr/agua/', source: 'metro', title: 'Corte de agua en Ponce' }),
    ], NOW);
    const sql = new DatabaseSync(':memory:');
    sql.exec('CREATE TABLE story_ids (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE)');
    sql.prepare('INSERT INTO story_ids(url) VALUES(?)').run('https://www.elnuevodia.com/luma/');
    const wrap = (db: DatabaseSync) => ({
      prepare(text: string) {
        return {
          bind(...args: SQLInputValue[]) {
            return { async all() { return { results: db.prepare(text).all(...args) }; } };
          },
        };
      },
    });
    let seen = '';
    const logging = {
      prepare(text: string) {
        seen = text;
        return wrap(sql).prepare(text);
      },
    };
    await attachThemeStoryIds({ DB: logging as unknown as D1Database }, report);
    expect(seen).toContain('SELECT id, url FROM story_ids');
    expect(seen).not.toContain('articles');
    const examples = report.themes.flatMap(theme => theme.examples);
    expect(examples.find(example => example.url.includes('elnuevodia'))!.storyId).toBe(1);
    expect(examples.find(example => example.url.includes('metro'))!.storyId).toBeNull();

    const failed = buildRecurringThemes([
      item({ url: 'https://www.elnuevodia.com/luma/', source: 'endi', title: 'LUMA anuncia un apagón' }),
    ], NOW);
    await attachThemeStoryIds({
      DB: { prepare() { throw new Error('no such table: story_ids'); } } as unknown as D1Database,
    }, failed);
    expect(failed.themes.flatMap(theme => theme.examples).every(example => example.storyId === null)).toBe(true);
  });
});

describe('comparison page themes', () => {
  const shared = 'https://www.elnuevodia.com/luma-junta/';
  const items = [
    item({
      url: shared,
      source: 'endi',
      title: 'LUMA y la Junta de Supervisión Fiscal llegan al tribunal',
      summary: 'El juez escuchó a las partes.',
      time: NOW - DAY,
    }),
    item({
      url: 'https://www.elnuevodia.com/parque/',
      source: 'endi',
      title: 'El gobernador visita un parque',
      summary: 'Sin las frases de estos temas.',
    }),
  ];
  const translations = {
    [items[1].url]: {
      originalTitle: items[1].title,
      originalSummary: items[1].summary,
      title: 'ONLY-IN-TRANSLATION power outage',
      summary: 'Department of Health and a public school.',
    },
  };

  it('places the panel between the sections and the daily charts', async () => {
    const live = { items, translations, feeds: [], now: NOW };
    const es = await renderer.fetch(new Request('https://news.dev.pr/comparar'), live).text();
    const en = await renderer.fetch(new Request('https://news.dev.pr/comparar?lang=en'), live).text();
    for (const html of [es, en]) {
      expect(html.indexOf('id="compare-topics"')).toBeLessThan(html.indexOf('id="temas-detectados"'));
      expect(html.indexOf('id="temas-detectados"')).toBeLessThan(html.indexOf('id="compare-days"'));
      expect(html).not.toContain('ONLY-IN-TRANSLATION');
      expect(html).toContain('LUMA y la Junta de Supervisión Fiscal llegan al tribunal');
    }
    expect(es).toContain('Temas detectados por frases');
    expect(en).toContain('Themes detected by phrases');
    expect(en).toContain('does not read the stored translation');
    const statsEn = await renderer.fetch(new Request('https://news.dev.pr/stats?lang=en'), { items: [], translations: {}, feeds: [] }).text();
    const statsEs = await renderer.fetch(new Request('https://news.dev.pr/stats'), { items: [], translations: {}, feeds: [] }).text();
    expect(statsEn).toContain('href="/comparar?lang=en#temas-detectados"');
    expect(statsEn).toContain('Detected themes');
    expect(statsEs).toContain('href="/comparar?lang=es#temas-detectados"');
    expect(statsEs).toContain('Temas detectados');
    expect(css).toContain('.theme-grid{display:grid;grid-template-columns:1fr');
    expect(css).toContain('.compare-open-quiet{background:transparent');
    expect(css).toContain('.theme-example a:focus-visible,.compare-open:focus-visible{outline:2px solid var(--ink)');
    expect(css).toContain('.card.lead.noimg,.card.hero.noimg{display:grid');
    expect(css).toContain('.tiles>.card.lead:not(.noimg) .picture{aspect-ratio:16/9}');
    expect(css).not.toContain('.tiles>.card.lead .picture{aspect-ratio:16/9}');
    expect(css).toContain('.explainer summary{');
    expect(css).toContain('@media(max-width:390px)');
    expect(css).toContain('@media(min-width:760px)');
  });
});
