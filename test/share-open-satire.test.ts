import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import renderer from '../src/render';
import worker from '../src/index';
import { lighterClientScript, key, valid } from '../src/lighter';
import { SATIRE_BLOCK_LABEL, SATIRE_PREVIEW_PREFIX, shareClipboard, shareClientScript, sharePath, sharePayload } from '../src/share';
import { NOINDEX_FOLLOW } from '../src/seo';
import type { Env } from '../src/ingest';
import type { Item } from '../src/parse';
import type { Translation } from '../src/i18n';

const require = createRequire('/home/adam/code/hbpr/package.json');
const { chromium } = require('playwright-core') as {
  chromium: {
    executablePath: () => string;
    launch: (opts: { executablePath: string; args: string[] }) => Promise<{
      newPage: (opts: { viewport: { width: number; height: number } }) => Promise<PwPage>;
      close: () => Promise<void>;
    }>;
  };
};

type Box = { x: number; y: number; width: number; height: number } | null;
type PwPage = {
  setContent: (html: string, opts: { waitUntil: 'domcontentloaded' }) => Promise<void>;
  goto: (url: string, opts: { waitUntil: 'domcontentloaded' }) => Promise<unknown>;
  locator: (selector: string) => {
    innerText: () => Promise<string>;
    boundingBox: () => Promise<Box>;
    click: () => Promise<void>;
  };
  evaluate: <T>(expression: string) => Promise<T>;
  route: (pattern: string, handler: (route: {
    request: () => { url: () => string };
    fulfill: (opts: { status: number; contentType: string; body: string }) => Promise<void>;
    abort: () => Promise<void>;
  }) => Promise<void> | void) => Promise<void>;
};

const now = Date.now();
let n = 0;
const story = (over: Partial<Item> & { title: string }): Item => ({
  url: `https://example.org/noticel/${++n}`, source: 'noticel', summary: 'El portavoz confirmó el cambio de horario esta mañana.', image: '', time: now - 60_000, observed: false, section: 'politica', reason: 'test', ...over,
});
const render = (path: string, items: Item[], extra: Record<string, unknown> = {}) =>
  renderer.fetch(new Request('https://news.dev.pr' + path), { items, translations: {}, feeds: [], ...extra });
const headOf = (html: string) => html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const articleOf = (html: string, title: string) => {
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  const at = main.indexOf('>' + esc(title) + '</a>');
  return main.slice(main.lastIndexOf('<article', at), main.indexOf('</article>', at));
};
const pageScript = (html: string) => {
  const marker = "closest('.share-ask')";
  const at = html.indexOf(marker);
  const start = html.lastIndexOf('(function()', at);
  return html.slice(start, html.indexOf('})();', at) + 5);
};

const line = 'El titular se quedó mirando sus propias comillas con calma y sin ninguna prisa.';
const marked = 'El titular se quedó mirando el & y sus "comillas" con calma y sin ninguna prisa.';
const englishLine = 'The new schedule arrived again and filed itself with unusual calm this morning.';
const headline = 'Titular con & "comillas" <y>';
const excerpt = 'Extracto con & y "comillas" que no se reescribe.';

describe('share payload', () => {
  it('adds only satire=1 when the line is open, and keeps the line out of the URL', () => {
    expect(sharePath('/story?id=7', false)).toBe('/story?id=7');
    expect(sharePath('/story?id=7&lang=en', false)).toBe('/story?id=7&lang=en');
    expect(sharePath('/story?id=7', true)).toBe('/story?id=7&satire=1');
    expect(sharePath('/story?id=7&lang=en', true)).toBe('/story?id=7&satire=1&lang=en');
    expect(sharePath('/story?id=7', true)).not.toContain(marked);
    expect(sharePath('/story?id=07', true)).toBe('');
    expect(sharePath('/story?id=7&satire=1', true)).toBe('');
    expect(sharePath('https://evil.example/story?id=7', true)).toBe('');

    const open = sharePayload('Titular', 'https://news.dev.pr/story?id=7&satire=1', 'es', marked);
    expect(open).toEqual({
      title: 'Titular',
      url: 'https://news.dev.pr/story?id=7&satire=1',
      text: `${marked} — Sátira de IA`,
    });
    expect(open.url).not.toContain(marked);
    expect(open.text).toContain('&');
    expect(shareClipboard(open)).toBe(`${open.text} ${open.url}`);

    const english = sharePayload('Headline', 'https://news.dev.pr/story?id=7&satire=1&lang=en', 'en', englishLine);
    expect(english.text).toBe(`${englishLine} — AI satire`);
    expect(shareClipboard(english)).toBe(`${english.text} ${english.url}`);

    const closed = sharePayload('Titular', 'https://news.dev.pr/story?id=7', 'es', '');
    expect(closed).toEqual({ title: 'Titular', url: 'https://news.dev.pr/story?id=7' });
    expect(closed).not.toHaveProperty('text');
    expect(shareClipboard(closed)).toBe('https://news.dev.pr/story?id=7');
  });

  it('builds the Web Share payload from the open card and falls back to the plain permalink', async () => {
    const item = story({ title: headline, summary: excerpt });
    const html = await (await render('/', [item], { storyIds: { [item.url]: 7 }, lighter: { [key(item, 'es')]: line } })).text();
    const script = pageScript(html);
    expect(script).toBe(shareClientScript);
    expect(script).not.toContain(line);
    expect(script).not.toContain('innerHTML');
    expect(script).toContain('Enlace copiado');
    expect(script).toContain('Link copied');
    expect(script).toContain('location.origin+path');
    expect(script).toContain('location.assign(url)');
    expect(articleOf(html, headline)).not.toContain(line);

    async function click(opts: { path: string; lang: 'es' | 'en'; title: string; line: string; expanded: boolean; mode: string; share?: boolean; clipboard?: boolean; fail?: 'abort' | 'share' | 'clip' }) {
      const shared: unknown[] = [];
      const copied: string[] = [];
      const assigned: string[] = [];
      const span = { textContent: opts.line };
      const ask = {
        getAttribute(name: string) {
          if (name === 'aria-expanded') return opts.expanded ? 'true' : 'false';
          if (name === 'data-mode') return opts.mode;
          return null;
        },
      };
      const note = { textContent: '' };
      const button = {
        attrs: { 'data-share-path': opts.path, 'data-share-lang': opts.lang } as Record<string, string>,
        getAttribute(name: string) { return this.attrs[name] ?? null; },
        setAttribute(name: string, value: string) { this.attrs[name] = String(value); },
        closest(sel: string) {
          return sel === 'article' ? article : null;
        },
        parentNode: { querySelector(sel: string) { return sel === '.share-note' ? note : null; } },
      };
      const article = {
        querySelector(sel: string) {
          if (sel === '.lighter-note span') return opts.line ? span : null;
          if (sel === '.lighter-ask') return ask;
          if (sel === 'h2 a, h3 a') return { textContent: opts.title };
          return null;
        },
      };
      const target = { closest(sel: string) { return sel === '.share-ask' ? button : null; } };
      const clicks: Record<string, (event: { target: unknown }) => void> = {};
      const context = {
        Date, String, Promise,
        document: { addEventListener(type: string, fn: (event: { target: unknown }) => void) { clicks[type] = fn; } },
        navigator: {
          share: opts.share === false ? undefined : (data: unknown) => {
            shared.push(data);
            if (opts.fail === 'abort') return Promise.reject(Object.assign(new Error('abort'), { name: 'AbortError' }));
            if (opts.fail === 'share') return Promise.reject(new Error('failed'));
            return Promise.resolve();
          },
          clipboard: opts.clipboard === false ? undefined : {
            writeText(text: string) {
              copied.push(text);
              return opts.fail === 'clip' ? Promise.reject(new Error('clip')) : Promise.resolve();
            },
          },
        },
        location: { origin: 'https://news.dev.pr', assign(url: string) { assigned.push(url); } },
        setTimeout() { return 0; },
      };
      runInNewContext(script, context);
      clicks.click({ target });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      return { shared, copied, assigned, note };
    }

    const open = await click({ path: '/story?id=7', lang: 'es', title: headline, line: marked, expanded: true, mode: 'open' });
    expect(open.shared).toEqual([{
      title: headline,
      url: 'https://news.dev.pr/story?id=7&satire=1',
      text: `${marked} — Sátira de IA`,
    }]);
    expect(JSON.stringify(open.shared)).not.toContain(encodeURIComponent(marked));
    expect((open.shared[0] as { url: string }).url).not.toContain(marked);

    const closed = await click({ path: '/story?id=7&lang=en', lang: 'en', title: 'Headline', line: '', expanded: false, mode: '' });
    expect(closed.shared).toEqual([{ title: 'Headline', url: 'https://news.dev.pr/story?id=7&lang=en' }]);
    expect(closed.shared[0]).not.toHaveProperty('text');

    const hidden = await click({ path: '/story?id=7', lang: 'es', title: headline, line: marked, expanded: false, mode: 'closed' });
    expect(hidden.shared).toEqual([{ title: headline, url: 'https://news.dev.pr/story?id=7' }]);

    const fallback = await click({ path: '/story?id=7', lang: 'es', title: headline, line: marked, expanded: true, mode: 'open', fail: 'share' });
    expect(fallback.copied).toEqual([`${marked} — Sátira de IA https://news.dev.pr/story?id=7&satire=1`]);
    expect(fallback.note.textContent).toBe('Enlace copiado');

    const aborted = await click({ path: '/story?id=7', lang: 'es', title: headline, line: marked, expanded: true, mode: 'open', fail: 'abort' });
    expect(aborted.copied).toEqual([]);
    expect(aborted.assigned).toEqual([]);

    const copiedUrl = await click({ path: '/story?id=7&lang=en', lang: 'en', title: 'Headline', line: '', expanded: false, mode: '', share: false });
    expect(copiedUrl.copied).toEqual(['https://news.dev.pr/story?id=7&lang=en']);
    expect(copiedUrl.note.textContent).toBe('Link copied');

    const navigated = await click({ path: '/story?id=7', lang: 'es', title: headline, line: '', expanded: false, mode: '', share: false, clipboard: false });
    expect(navigated.assigned).toEqual(['https://news.dev.pr/story?id=7']);
  });
});

describe('satire share landing', () => {
  const item = story({ title: headline, summary: excerpt, image: 'https://img.example/photo.jpg' });
  const english: Translation = { originalTitle: headline, originalSummary: excerpt, title: 'Headline with & "quotes" <and>', summary: 'Excerpt with & and "quotes" left verbatim.' };
  const lighter = { [key(item, 'es')]: marked, [key(item, 'en')]: englishLine };

  it('labels and escapes the preview, pre-opens the line, and noindexes only satire=1', async () => {
    expect(valid(marked, item, 'es')).toBe(true);
    expect(valid(englishLine, item, 'en')).toBe(true);
    expect(lighterClientScript).toContain(SATIRE_BLOCK_LABEL.es);
    expect(lighterClientScript).toContain(SATIRE_BLOCK_LABEL.en);

    const html = await (await render(`/story?id=7&satire=1&cb=${now}`, [item], { story: true, storyIds: { [item.url]: 7 }, lighter })).text();
    const head = headOf(html);
    const card = articleOf(html, headline);
    const preview = `${SATIRE_PREVIEW_PREFIX.es}${marked}`;
    expect(head).toContain(`<meta property="og:title" content="${esc(headline)}">`);
    expect(head).toContain(`<meta property="og:description" content="${esc(preview)}">`);
    expect(head).toContain(`<meta name="twitter:description" content="${esc(preview)}">`);
    expect(head).toContain('<meta property="og:image" content="https://img.example/photo.jpg">');
    expect(head).toContain('<meta property="og:url" content="https://news.dev.pr/story?id=7">');
    expect(head).toContain('<link rel="canonical" href="https://news.dev.pr/story?id=7">');
    expect(head).not.toContain('satire=1');
    expect(head).not.toContain('cb=');
    expect(head.match(/rel="canonical"/g)).toHaveLength(1);
    expect(head.match(/name="robots"/g)).toHaveLength(1);
    expect(head).toContain(NOINDEX_FOLLOW);
    expect(head).toContain('<link rel="alternate" hreflang="es" href="https://news.dev.pr/story?id=7">');
    expect(card).toContain('data-cached="1"');
    expect(card).toContain('data-mode="open"');
    expect(card).toContain('aria-expanded="true"');
    expect(card).toContain('>Ocultar sátira<');
    expect(card).toContain(`<small>${SATIRE_BLOCK_LABEL.es}</small><br><span>${esc(marked)}</span>`);
    expect(card).toContain('data-share-path="/story?id=7"');
    expect(card).not.toContain('satire=1');
    expect(card).not.toContain(encodeURIComponent(marked));
    expect(html).toContain('/click?url=' + encodeURIComponent(item.url));
    expect(html).toContain(esc(headline));

    const plain = await (await render('/story?id=7', [item], { story: true, storyIds: { [item.url]: 7 }, lighter })).text();
    const plainHead = headOf(plain);
    expect(plainHead).toContain(`<meta property="og:description" content="${esc(excerpt)}">`);
    expect(plainHead).not.toContain('twitter:description');
    expect(plainHead).not.toContain('name="robots"');
    expect(plainHead).not.toContain(marked);
    expect(plain).not.toContain(marked);
    expect(plain).not.toContain(esc(marked));
    expect(articleOf(plain, headline)).toContain('>Mostrar sátira<');
    expect(articleOf(plain, headline)).toContain('aria-expanded="false"');
    expect(articleOf(plain, headline)).not.toContain('data-mode="open"');

    const home = await (await render(`/?cb=${now}`, [item], { storyIds: { [item.url]: 7 }, lighter })).text();
    expect(home).not.toContain(marked);
    expect(home).not.toContain(esc(marked));
    expect(headOf(home)).not.toContain('name="robots"');
    expect(articleOf(home, headline)).toContain('>Mostrar sátira<');
  });

  it('uses the English line on the English satire link and keeps a real https image', async () => {
    const html = await (await render('/story?id=7&satire=1&lang=en', [item], { story: true, storyIds: { [item.url]: 7 }, lighter, translations: { [item.url]: english } })).text();
    const head = headOf(html);
    const preview = `${SATIRE_PREVIEW_PREFIX.en}${englishLine}`;
    expect(head).toContain(`<meta property="og:title" content="${esc(english.title)}">`);
    expect(head).toContain(`<meta property="og:description" content="${esc(preview)}">`);
    expect(head).toContain(`<meta name="twitter:description" content="${esc(preview)}">`);
    expect(head).toContain('<meta property="og:image" content="https://img.example/photo.jpg">');
    expect(head).toContain('<link rel="canonical" href="https://news.dev.pr/story?id=7&amp;lang=en">');
    expect(head).toContain('<meta property="og:url" content="https://news.dev.pr/story?id=7&amp;lang=en">');
    expect(head).not.toContain('satire=1');
    expect(head).toContain(NOINDEX_FOLLOW);
    expect(head.match(/name="robots"/g)).toHaveLength(1);
    const card = articleOf(html, english.title);
    expect(card).toContain('>Hide satire<');
    expect(card).toContain(`<span>${esc(englishLine)}</span>`);
    expect(card).toContain(SATIRE_BLOCK_LABEL.en);
    expect(card).toContain('data-share-path="/story?id=7&amp;lang=en"');
    expect(card).toContain('aria-expanded="true"');
    expect(html).toContain('/click?url=' + encodeURIComponent(item.url));
  });

  it('keeps the ordinary story page when the stored line is missing or invalid', async () => {
    const missing = await (await render('/story?id=7&satire=1', [item], { story: true, storyIds: { [item.url]: 7 } })).text();
    expect(headOf(missing)).toContain(`<meta property="og:description" content="${esc(excerpt)}">`);
    expect(headOf(missing)).not.toContain('twitter:description');
    expect(headOf(missing)).toContain(NOINDEX_FOLLOW);
    expect(headOf(missing)).toContain('<link rel="canonical" href="https://news.dev.pr/story?id=7">');
    expect(missing).not.toContain(marked);
    expect(articleOf(missing, headline)).toContain('>Mostrar sátira<');
    expect(articleOf(missing, headline)).toContain('aria-expanded="false"');

    const invalidLine = 'The headline waited around and then filed the same joke twice.';
    expect(valid(invalidLine, item, 'es')).toBe(false);
    const invalid = await (await render('/story?id=7&satire=1', [item], { story: true, storyIds: { [item.url]: 7 }, lighter: { [key(item, 'es')]: invalidLine } })).text();
    expect(invalid).not.toContain(invalidLine);
    expect(headOf(invalid)).toContain(`<meta property="og:description" content="${esc(excerpt)}">`);
    expect(headOf(invalid)).not.toContain('twitter:description');
    expect(headOf(invalid)).toContain(NOINDEX_FOLLOW);
    expect(articleOf(invalid, headline)).toContain('>Mostrar sátira<');
    expect(articleOf(invalid, headline)).toContain('data-cached="0"');
  });

  it('hides a pre-opened line and shows it again without a model call', () => {
    function node(tag: string) {
      const el: {
        tag: string; _text: string; children: { tag: string; textContent: string }[];
        appendChild: (child: { tag: string; textContent: string }) => { tag: string; textContent: string };
        querySelector: (sel: string) => { tag: string; textContent: string } | null;
        textContent: string;
      } = {
        tag,
        _text: '',
        children: [],
        appendChild(child) { this.children.push(child); return child; },
        querySelector(sel: string) {
          if (sel !== 'span') return null;
          return this.children.find(child => child.tag === 'span') ?? null;
        },
        get textContent() { return this._text; },
        set textContent(value: string) { this._text = String(value); this.children = []; },
      };
      return el;
    }
    const note = node('p');
    const span = node('span');
    span.textContent = line;
    note.children = [node('small'), node('br'), span];
    const button = {
      disabled: false,
      textContent: 'Ocultar sátira',
      attrs: { 'data-lighter-lang': 'es', 'data-lighter-url': item.url, 'data-cached': '1', 'aria-expanded': 'true' } as Record<string, string>,
      parentNode: { querySelector: () => note },
      setAttribute(name: string, value: string) { this.attrs[name] = String(value); },
      getAttribute(name: string) { return this.attrs[name] ?? null; },
      removeAttribute(name: string) { delete this.attrs[name]; },
      closest(selector: string) { return selector === '.lighter-ask' ? button : null; },
    };
    const listeners: Record<string, (event: { target: unknown }) => void> = {};
    const fetchMock = vi.fn(async () => { throw new Error('model'); });
    const previous = { document: globalThis.document, fetch: globalThis.fetch };
    globalThis.document = {
      addEventListener(type: string, fn: (event: { target: unknown }) => void) { listeners[type] = fn; },
      createElement(tag: string) { return node(tag); },
    } as unknown as Document;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      eval(lighterClientScript);
      listeners.click({ target: button });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(button.textContent).toBe('Mostrar sátira');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.getAttribute('data-mode')).toBe('closed');
      expect(button.getAttribute('data-cached')).toBe('1');
      expect(note.textContent).toBe('');
      expect(note.querySelector('span')).toBeNull();
      listeners.click({ target: button });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(button.textContent).toBe('Ocultar sátira');
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(button.getAttribute('data-mode')).toBe('open');
      expect(button.getAttribute('data-cached')).toBe('1');
      expect(note.querySelector('span')?.textContent).toBe(line);
    } finally {
      globalThis.document = previous.document;
      globalThis.fetch = previous.fetch;
    }
  });
});

describe('story satire route', () => {
  function setup() {
    const sql = new DatabaseSync(':memory:');
    for (const file of ['migrations/0001_live.sql', 'migrations/0003_search_clicks.sql', 'migrations/0011_lighter.sql']) sql.exec(readFileSync(file, 'utf8'));
    const seen: string[] = [];
    const DB = {
      prepare(text: string) {
        seen.push(text);
        let args: unknown[] = [];
        return {
          bind(...values: unknown[]) { args = values; return this; },
          async first() { return sql.prepare(text).get(...(args as never[])) ?? null; },
          async all() { return { results: sql.prepare(text).all(...(args as never[])) }; },
          async run() { const result = sql.prepare(text).run(...(args as never[])); return { meta: { changes: Number(result.changes) } }; },
        };
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) { return Promise.all(statements.map(s => s.run())); },
    };
    return { sql, seen, env: { DB } as unknown as Env };
  }

  it('reads the stored line for satire=1 and does not call the model', async () => {
    const { sql, seen, env } = setup();
    const item = story({ title: 'Horario nuevo en las oficinas de Bayamón', summary: 'El portavoz confirmó el cambio de horario esta mañana.', image: 'https://img.example/photo.jpg' });
    expect(valid(line, item, 'es')).toBe(true);
    sql.prepare('INSERT INTO articles(url,source,payload,translation,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?,?)')
      .run(item.url, item.source, JSON.stringify(item), null, item.time, item.time, item.time);
    const id = (sql.prepare('SELECT id FROM story_ids WHERE url=?').get(item.url) as { id: number }).id;
    sql.prepare('INSERT INTO lighter_cache(key,text,attempts,next_try) VALUES(?,?,?,?)').run(key(item, 'es'), line, 1, 0);
    const run = vi.fn(() => { throw new Error('model called'); });
    const bound = { ...env, AI: { run } } as unknown as Env;
    seen.length = 0;
    const page = await worker.fetch(new Request(`https://news.dev.pr/story?id=${id}&satire=1&cb=share-${now}`), bound);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    const head = headOf(html);
    expect(html).toContain(`<span>${esc(line)}</span>`);
    expect(html).toContain('>Ocultar sátira<');
    expect(html).toContain('/click?url=' + encodeURIComponent(item.url));
    expect(head).toContain(`<meta property="og:description" content="${esc(SATIRE_PREVIEW_PREFIX.es + line)}">`);
    expect(head).toContain(`<meta name="twitter:description" content="${esc(SATIRE_PREVIEW_PREFIX.es + line)}">`);
    expect(head).toContain(`<link rel="canonical" href="https://news.dev.pr/story?id=${id}">`);
    expect(head).not.toContain('satire=1');
    expect(head).toContain(NOINDEX_FOLLOW);
    expect(run).not.toHaveBeenCalled();
    expect(seen.some(sqlText => /^\s*(INSERT|UPDATE|DELETE)/i.test(sqlText))).toBe(false);
    expect(seen.some(sqlText => sqlText.includes('lighter_cache'))).toBe(true);

    const invalidLine = '<script>alert(1)</script> el titular se quedó mirando.';
    expect(valid(invalidLine, item, 'es')).toBe(false);
    sql.prepare('UPDATE lighter_cache SET text=? WHERE key=?').run(invalidLine, key(item, 'es'));
    seen.length = 0;
    const withheld = await worker.fetch(new Request(`https://news.dev.pr/story?id=${id}&satire=1&cb=share-invalid-${now}`), bound);
    const withheldHtml = await withheld.text();
    expect(withheldHtml).not.toContain(invalidLine);
    expect(withheldHtml).not.toContain(esc(invalidLine));
    expect(withheldHtml).not.toContain('<script>alert');
    expect(headOf(withheldHtml)).toContain(`<meta property="og:description" content="${esc(item.summary)}">`);
    expect(headOf(withheldHtml)).not.toContain('twitter:description');
    expect(withheldHtml).toContain('>Mostrar sátira<');
    expect(run).not.toHaveBeenCalled();
    expect(seen.some(sqlText => /^\s*(INSERT|UPDATE|DELETE)/i.test(sqlText))).toBe(false);
  });
});

describe('satire landing layout', () => {
  it('shows the open line and the hide control at 390 and 1440', async () => {
    const item = story({ title: headline, summary: excerpt, image: 'https://img.example/photo.jpg' });
    expect(valid(marked, item, 'es')).toBe(true);
    const html = await (await render(`/story?id=7&satire=1&cb=layout-${now}`, [item], { story: true, storyIds: { [item.url]: 7 }, lighter: { [key(item, 'es')]: marked } })).text();
    const browser = await chromium.launch({ executablePath: chromium.executablePath(), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      for (const width of [390, 1440]) {
        const page = await browser.newPage({ viewport: { width, height: 1200 } });
        let lighterHits = 0;
        await page.route('https://news.dev.pr/**', route => {
          const url = route.request().url();
          if (url.includes('/api/lighter')) { lighterHits += 1; return route.abort(); }
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
        });
        await page.goto(`https://news.dev.pr/story?id=7&satire=1&cb=layout-${now}-${width}`, { waitUntil: 'domcontentloaded' });
        await page.evaluate(`window.__shares=[]; navigator.share=function(data){ window.__shares.push(data); return Promise.resolve(); };`);
        const before = await page.evaluate<{ scroll: number; client: number; note: string; ask: string; expanded: string; link: string; clamp: string }>(`(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
          note: document.querySelector('.lighter-note').innerText,
          ask: document.querySelector('.lighter-ask').textContent,
          expanded: document.querySelector('.lighter-ask').getAttribute('aria-expanded'),
          link: document.querySelector('article h3 a').getAttribute('href'),
          clamp: getComputedStyle(document.querySelector('.lighter-note')).webkitLineClamp
        }))()`);
        expect(before.scroll, String(width)).toBeLessThanOrEqual(before.client + 1);
        expect(before.note).toContain(marked);
        expect(before.note).toContain(SATIRE_BLOCK_LABEL.es);
        expect(before.ask).toBe('Ocultar sátira');
        expect(before.expanded).toBe('true');
        expect(before.link).toContain('/click?url=');
        expect(before.clamp === 'none' || before.clamp === 'unset' || before.clamp === '').toBe(true);
        for (const selector of ['.lighter-ask', '.share-ask', '.lighter-note', 'article h3 a']) {
          const box = await page.locator(selector).boundingBox();
          expect(box, selector).toBeTruthy();
          expect(box!.x, selector).toBeGreaterThanOrEqual(-1);
          expect(box!.x + box!.width, selector).toBeLessThanOrEqual(width + 1);
          expect(box!.width, selector).toBeGreaterThan(0);
        }
        await page.locator('.share-ask').click();
        const shared = await page.evaluate<Array<{ title: string; text?: string; url: string }>>('window.__shares');
        expect(shared).toEqual([{
          title: headline,
          text: `${marked} — Sátira de IA`,
          url: `https://news.dev.pr/story?id=7&satire=1`,
        }]);
        expect(shared[0].url).not.toContain(marked);
        await page.locator('.lighter-ask').click();
        const hidden = await page.evaluate<{ ask: string; note: string; expanded: string }>(`(() => ({
          ask: document.querySelector('.lighter-ask').textContent,
          note: document.querySelector('.lighter-note').textContent,
          expanded: document.querySelector('.lighter-ask').getAttribute('aria-expanded')
        }))()`);
        expect(hidden.ask).toBe('Mostrar sátira');
        expect(hidden.note).toBe('');
        expect(hidden.expanded).toBe('false');
        await page.locator('.lighter-ask').click();
        const again = await page.evaluate<{ ask: string; note: string; expanded: string }>(`(() => ({
          ask: document.querySelector('.lighter-ask').textContent,
          note: document.querySelector('.lighter-note').innerText,
          expanded: document.querySelector('.lighter-ask').getAttribute('aria-expanded')
        }))()`);
        expect(again.ask).toBe('Ocultar sátira');
        expect(again.expanded).toBe('true');
        expect(again.note).toContain(marked);
        expect(lighterHits).toBe(0);
        const reshared = page.locator('.share-ask');
        await page.evaluate('window.__shares=[]');
        await reshared.click();
        const second = await page.evaluate<Array<{ url: string; text?: string }>>('window.__shares');
        expect(second[0].url).toBe('https://news.dev.pr/story?id=7&satire=1');
        expect(second[0].text).toContain(marked);
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
});
