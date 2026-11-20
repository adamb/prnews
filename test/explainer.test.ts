import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import {ENTRIES, MAX_MATCHES, VERIFIED_ON, explainerCitations, explainerHtml, matchExplainer} from '../src/explainer';
import renderer from '../src/render';
import type {Item} from '../src/parse';

const hosts = new Set([
  'www.congress.gov',
  'www.govinfo.gov',
  'oversightboard.pr.gov',
  'juntasupervision.pr.gov',
  'poderjudicial.pr',
  'www.ceepur.org',
  'ww2.ceepur.org',
  'pnppr.com',
  'partidoindependentista.com',
  'bvirtualogp.pr.gov',
  'www.p3.pr.gov',
  'www.acueductos.pr.gov',
  'hacienda.pr.gov',
  'pr.gov',
  'www.desarrollo.pr.gov',
  'www.newfortressenergy.com',
  'ir.newfortressenergy.com',
  'www.ferc.gov',
  'www.distritot-mobile.com',
  'dialogo.upr.edu',
  'www.bbc.com',
  'www.si.edu',
  'uscode.house.gov',
]);

const panel = (html: string) => {
  const start = html.indexOf('<details class="explainer"');
  const end = html.indexOf('</details>', start);
  return start < 0 ? '' : html.slice(start, end + '</details>'.length);
};

it('keeps a dated curated glossary and does not call a model', () => {
  expect(VERIFIED_ON).toBe('2026-11-20');
  expect(MAX_MATCHES).toBe(3);
  const source = readFileSync('src/explainer.ts', 'utf8');
  expect(source).not.toMatch(/\bfetch\s*\(/);
  expect(source).not.toContain('innerHTML');
  expect(source).not.toMatch(/\/api\//);
  expect(source).not.toMatch(/AI\.run|workers-ai|@cf\/|env\.AI/);
  expect(explainerHtml('PROMESA certifica el plan.', 'es')).not.toBeInstanceOf(Promise);
});

it('keeps every entry concise with a source link', () => {
  expect(ENTRIES.length).toBe(24);
  for (const entry of ENTRIES) {
    expect(entry.es.body.length).toBeGreaterThanOrEqual(1);
    expect(entry.es.body.length).toBeLessThanOrEqual(2);
    expect(entry.en.body.length).toBeLessThanOrEqual(2);
    expect(entry.sources.length).toBeGreaterThan(0);
    expect(entry.es.title.length).toBeLessThanOrEqual(60);
    expect(entry.en.title.length).toBeLessThanOrEqual(60);
    for (const paragraph of [...entry.es.body, ...entry.en.body]) {
      expect(paragraph.length).toBeLessThanOrEqual(320);
    }
    // Neutrality kept without the old repeated disclaimer.
    expect(entry.es.body.join(' ')).not.toContain('no prueba que esa persona milite');
    expect(entry.en.body.join(' ')).not.toContain('does not prove membership');
  }
});

it('does not imply the blocked PDFs and the PIP site were rechecked on the review date', () => {
  const es = explainerHtml('El DDEC anuncia nuevos incentivos.', 'es');
  const en = explainerHtml('The resident commissioner requested funds.', 'en');
  for (const [html, latest, earlier] of [
    [es, '20 de noviembre de 2026', '19 de noviembre'],
    [en, 'November 20, 2026', 'November 19, 2026'],
  ] as [string, string, string][]) {
    expect(html).toContain(latest);
    expect(html).toContain(earlier);
  }
});

it('cites only https pages on the reviewed hosts', () => {
  const citations = explainerCitations();
  expect(citations.length).toBeGreaterThan(10);
  for (const citation of citations) {
    const url = new URL(citation.url);
    expect(url.protocol).toBe('https:');
    expect(hosts.has(url.hostname)).toBe(true);
    expect(url.username).toBe('');
    expect(url.password).toBe('');
  }
});

it('matches institutions and rejects lookalikes', () => {
  expect(matchExplainer('PROMESA certifica el plan fiscal.')).toEqual(['fomb']);
  expect(matchExplainer('La Junta de Supervisión Fiscal envió una carta.')).toEqual(['fomb']);
  expect(matchExplainer('Financial Oversight and Management Board letter')).toEqual(['fomb']);
  expect(matchExplainer('El gobernador hizo una promesa de mejores servicios.')).toEqual([]);
  expect(matchExplainer('The school board oversight committee met about lunches.')).toEqual([]);
  expect(matchExplainer('The oversight committee scheduled a hearing.')).toEqual(['oversight-committee']);
  expect(matchExplainer('La comisión de supervisión citó a dos agencias.')).toEqual(['oversight-committee']);
  expect(matchExplainer('Junta de Planificación aprueba el mapa.')).toEqual(['planning']);
  expect(matchExplainer('The board of directors met in San Juan.')).toEqual([]);
  expect(matchExplainer('pipeline work on the north coast')).toEqual([]);
  expect(matchExplainer('Ela Gómez visitó la escuela.')).toEqual([]);
  expect(matchExplainer('Athletes left for the Commonwealth Games.')).toEqual([]);
  expect(matchExplainer('PD 15 queda archivado.')).toEqual([]);
  expect(matchExplainer('Ley 60 de tránsito entra en vigor.')).toEqual([]);
  expect(matchExplainer('AAA de la liga de béisbol')).toEqual([]);
  expect(matchExplainer('Triple-A baseball returns.')).toEqual([]);
  expect(matchExplainer('AEE')).toEqual([]);
  expect(matchExplainer('La independencia judicial del tribunal.')).toEqual([]);
  expect(matchExplainer('Hacienda San Juan abre sus puertas.')).toEqual([]);
  expect(matchExplainer('El Senado de Estados Unidos votó.')).toEqual([]);
});

it('uses context before firing short names', () => {
  expect(matchExplainer('Código de Incentivos')).toEqual(['act60']);
  expect(matchExplainer('Act 60-2019 incentives decree')).toContain('act60');
  expect(matchExplainer('AAA informa un salidero de agua potable.')).toEqual(['aaa']);
  expect(matchExplainer('Autoridad de Acueductos y Alcantarillados')).toEqual(['aaa']);
  expect(matchExplainer('La AEE reporta un apagón.')).toEqual(['prepa']);
  expect(matchExplainer('LUMA restablece el servicio.')).toEqual(['luma']);
  expect(matchExplainer('LUMA y la AEE comparecen.')).toEqual(['luma']);
  const lumaAndPrepa = explainerHtml('LUMA y la AEE comparecen.', 'en');
  expect(lumaAndPrepa).toContain('data-explainer="luma"');
  expect(lumaAndPrepa).not.toContain('prepa');
  expect(lumaAndPrepa).toContain('Autoridad de Energía Eléctrica');
  expect(matchExplainer('Departamento de Hacienda abre la planilla.')).toEqual(['hacienda']);
  expect(matchExplainer('Commonwealth of Puerto Rico')).toEqual(['status-ela']);
  expect(matchExplainer('la independencia de Puerto Rico')).toEqual(['status-independence']);
  expect(matchExplainer('El PIP propone la independencia.')).toEqual(['pip']);
  expect(matchExplainer('PNP y estadidad')).toEqual(['pnp']);
  expect(matchExplainer('Promesa de cambio en la isla.')).toEqual([]);
  const pnpEs = explainerHtml('El PNP celebró asamblea.', 'es');
  const pnpEn = explainerHtml('The PNP held a meeting.', 'en');
  expect(pnpEs).toContain('5 de noviembre de 2024');
  expect(pnpEn).toContain('November 5, 2024');
  expect(pnpEs).not.toMatch(/lista completa|partidos de 2026/i);
  expect(pnpEn).not.toMatch(/complete 2026 roster|current roster/i);
  expect(matchExplainer('Proyecto Dignidad inscribe candidatos.')).toEqual(['pd']);
  expect(matchExplainer('La CEE certificó la elección.')).toEqual(['cee']);
  expect(matchExplainer('CEE')).toEqual([]);
});

it('matches the new entries only with their context guards', () => {
  expect(matchExplainer('El DDEC anuncia nuevos incentivos.')).toEqual(['ddec']);
  expect(matchExplainer('La secretaria de Desarrollo Económico y Comercio visita Ponce.')).toEqual(['ddec']);
  expect(matchExplainer('El desarrollo económico de la isla crece.')).toEqual([]);
  expect(matchExplainer('New Fortress Energy surte gas natural a la planta.')).toEqual(['nfe']);
  expect(matchExplainer('NFEnergía opera la terminal del puerto de San Juan.')).toEqual(['nfe']);
  expect(matchExplainer('NFE extiende el contrato con la AEE.')).toEqual(['nfe']);
  expect(matchExplainer('un nfe extraño')).toEqual([]);
  expect(matchExplainer('El Distrito T-Mobile llena su calendario de conciertos.')).toEqual(['distrito-tmobile']);
  expect(matchExplainer('Concierto en el T-Mobile District de San Juan.')).toEqual(['distrito-tmobile']);
  expect(matchExplainer('T-Mobile mejora la cobertura en la isla.')).toEqual([]);
  expect(matchExplainer('El distrito escolar aprueba el presupuesto.')).toEqual([]);
  expect(matchExplainer('El coquito navideño regresa a las mesas.')).toEqual(['coquito']);
  expect(matchExplainer('Concurso de coquito en Bayamón.')).toEqual(['coquito']);
  expect(matchExplainer('Escuelas adoptan el método de lectura Coquito.')).toEqual([]);
  expect(matchExplainer('Ronaldo anota tras el rumor de un traspaso.')).toEqual([]);
  expect(matchExplainer('Los taínos habitaban Borikén.')).toEqual(['taino']);
  expect(matchExplainer('Hallan vasija taína en una cueva de Arecibo.')).toEqual(['taino']);
  expect(matchExplainer('Petroglifo taíno será restaurado en Jayuya.')).toEqual(['taino']);
  expect(matchExplainer('Taína Rodríguez gana la medalla de oro.')).toEqual([]);
  expect(matchExplainer('Restaurante Taíno reabre en el Condado.')).toEqual([]);
});

it('describes the resident commissioner from the statute and CRS', () => {
  expect(matchExplainer('El comisionado residente en Washington presenta un proyecto.')).toEqual(['resident-commissioner']);
  const es = explainerHtml('La comisionada residente pidió una audiencia.', 'es');
  const en = explainerHtml('The resident commissioner requested a hearing.', 'en');
  for (const html of [es, en]) {
    expect(html).toContain('https://uscode.house.gov/us/usc/119-118/t48/s891/');
    expect(html).toContain('https://www.congress.gov/crs-product/R40170');
  }
  expect(es).toContain('48 U.S.C. § 891');
  expect(es).toContain('cuatro años');
  expect(es).toContain('no puede votar en el pleno');
  expect(en).toContain('four-year term');
  expect(en).toContain('not on the House floor');
  expect(en).not.toContain('Jenniffer');
});

it('caps matches and stays in the view language with citations', () => {
  const crowded = 'PROMESA, el Senado, el PNP, el PIP, el MVC, Proyecto Dignidad, LUMA y el Estado Libre Asociado.';
  expect(matchExplainer(crowded).slice(0, 3)).toEqual(['fomb', 'legislature', 'pnp']);
  const spanish = explainerHtml(crowded, 'es');
  const english = explainerHtml(crowded, 'en');
  expect(spanish).toContain('data-explainer="fomb,legislature,pnp"');
  expect(spanish).toContain('>Contexto</summary>');
  expect(spanish).toContain('glosario revisado');
  expect(spanish).toContain('Se muestran tres.');
  expect(spanish).not.toContain('reviewed glossary');
  expect(english).toContain('>Context</summary>');
  expect(english).toContain('reviewed glossary');
  expect(english).toContain('Three are shown.');
  expect(english).not.toContain('glosario revisado');
  expect(english).toContain('lang="en"');
  expect(spanish).toContain('https://www.congress.gov/114/plaws/publ187/PLAW-114publ187.pdf');
  expect(spanish).not.toMatch(/<details class="explainer"[^>]*\sopen[\s>]/);
  expect(english).not.toContain('Jenniffer');
  expect(english).not.toContain('$72');
  expect(panel(english)).not.toMatch(/is a member|pertenece|afiliad/i);
});

it('escapes card text and does not invent a party for an official', () => {
  const nasty = 'Junta de Supervisión Fiscal <script>alert(1)</script> "onmouseover=&';
  const html = explainerHtml(nasty, 'en');
  expect(html).toContain('Financial Oversight and Management Board');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('onmouseover');
  expect(html).not.toContain('&lt;script&gt;');
  const official = explainerHtml('La gobernadora criticó al PNP.', 'es');
  expect(official).toContain('su declaración, no una descripción de la ley vigente');
  expect(official).not.toContain('no prueba');
  expect(official).not.toMatch(/gobernadora es|pertenece al PNP|afiliada|milita en/i);
});

it('renders a closed bilingual disclosure without calling AI or rewriting the headline', async () => {
  const story = {
    url: 'https://example.com/promesa',
    title: 'PROMESA <img src=x onerror=alert(1)>',
    summary: 'La Junta de Supervisión Fiscal envió una carta.',
    source: 'endi',
    image: '',
    time: Date.now(),
    observed: false,
    section: 'politica',
    reason: 'test',
  } as Item;
  const translations = {
    [story.url]: {
      originalTitle: story.title,
      originalSummary: story.summary,
      title: 'Board <img src=x onerror=alert(1)>',
      summary: 'The Financial Oversight and Management Board sent a letter.',
    },
  };
  for (const lang of ['es', 'en'] as const) {
    const html = await renderer.fetch(new Request('https://news.dev.pr/search?lang=' + lang), {
      items: [story],
      translations,
      feeds: [],
    }).text();
    const note = panel(html);
    expect(note).toContain('class="explainer"');
    expect(note).toContain(lang === 'es' ? '>Contexto</summary>' : '>Context</summary>');
    expect(note).not.toContain('<img src=x');
    expect(note).not.toContain('<script>');
    expect(note).not.toContain('sátira');
    expect(note).not.toContain('satire');
    expect(note).not.toContain('/api/');
    const visible = lang === 'es' ? 'PROMESA &lt;img src=x onerror=alert(1)&gt;' : 'Board &lt;img src=x onerror=alert(1)&gt;';
    expect(html).toContain(visible);
    expect(html).toContain('class="lighter-ask"');
    expect(html.indexOf('class="explainer"')).toBeLessThan(html.indexOf('class="lighter"'));
    expect(html).toContain('min-height:44px');
    expect(html).toContain('--bg:#0e1311');
    expect(html).toContain('color-scheme');
    expect(html).not.toContain('innerHTML');
    expect(html).not.toContain('/api/explainer');
  }
  const plain = await renderer.fetch(new Request('https://news.dev.pr/'), {
    items: [{...story, title: 'Traffic delays', summary: 'The agency reports traffic delays.'}],
    translations: {},
    feeds: [],
  }).text();
  expect(plain).not.toContain('class="explainer"');
  expect(plain).toContain('Traffic delays');
});
