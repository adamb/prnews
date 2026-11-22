import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichImages } from '../src/image-enrich';
import type { Env } from '../src/ingest';
import type { Item } from '../src/parse';
import type { Translation } from '../src/i18n';
import {
  canonicalNewsprRepairTarget,
  createWranglerD1,
  formatSql,
  repairNewsprUrls,
} from '../scripts/repair-newspr-urls';

const NOW = Date.parse('2026-11-21T20:00:00Z');
const HOUR = 3_600_000;

function setupDb() {
  const sql = new DatabaseSync(':memory:');
  for (const migration of [
    '0001_live.sql',
    '0002_archive.sql',
    '0003_search_clicks.sql',
    '0008_click_totals.sql',
    '0009_alerts.sql',
    '0010_image_enrich.sql',
  ]) {
    sql.exec(readFileSync(`migrations/${migration}`, 'utf8'));
  }

  const DB = {
    prepare(text: string) {
      let args: any[] = [];
      return {
        bind(...values: any[]) {
          args = values;
          return this;
        },
        async first() {
          return sql.prepare(text).get(...args) ?? null;
        },
        async all() {
          return { results: sql.prepare(text).all(...args) };
        },
        async run() {
          const res = sql.prepare(text).run(...args);
          return { meta: { changes: Number(res.changes) } };
        },
      };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      sql.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        sql.exec('COMMIT');
        return out;
      } catch (err) {
        sql.exec('ROLLBACK');
        throw err;
      }
    },
  } as unknown as D1Database;

  return { sql, DB };
}

const makeItem = (url: string, title: string, summary: string, source = 'newspr', time = NOW - HOUR): Item => ({
  url,
  source,
  title,
  summary,
  image: '',
  time,
  observed: false,
  section: 'energia',
  reason: 'category',
  ...(source === 'newspr' ? { categories: ['Energy & Grid'] } : {}),
});

const makeSpanishTranslation = (item: Item, title: string, summary: string): Translation => ({
  target: 'es',
  originalTitle: item.title,
  originalSummary: item.summary,
  title,
  summary,
});

function insertArticle(
  sql: DatabaseSync,
  item: Item,
  opts: { firstSeen?: number; updatedAt?: number; translation?: Translation | null } = {}
) {
  const firstSeen = opts.firstSeen ?? item.time;
  const updatedAt = opts.updatedAt ?? item.time;
  sql.prepare(
    'INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at,translation) VALUES(?,?,?,?,?,?,?)'
  ).run(
    item.url,
    item.source,
    JSON.stringify(item),
    firstSeen,
    updatedAt,
    item.time,
    opts.translation ? JSON.stringify(opts.translation) : null
  );
}

function insertAccount(sql: DatabaseSync, id: string, email: string) {
  sql.prepare("INSERT INTO alert_accounts(id,email,language,status,created_at) VALUES(?,?,'es','active',?)")
    .run(id, email, NOW - 2 * HOUR);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('canonicalNewsprRepairTarget & SQL helpers', () => {
  it('targets only legacy trailing-slash non-root news.pr URLs', () => {
    expect(canonicalNewsprRepairTarget('https://news.pr/story/abc123/')).toBe('https://news.pr/story/abc123');
    expect(canonicalNewsprRepairTarget('https://news.pr/story/abc123///?keep=1')).toBe('https://news.pr/story/abc123?keep=1');
    expect(canonicalNewsprRepairTarget('https://news.pr/story/abc123')).toBeNull();
    expect(canonicalNewsprRepairTarget('https://news.pr/')).toBeNull();
    expect(canonicalNewsprRepairTarget('https://news.pr///')).toBeNull();
    expect(canonicalNewsprRepairTarget('https://www.noticel.com/gobierno/x/')).toBeNull();
  });

  it('escapes SQL parameters outside string literals and unsets CLOUDFLARE_API_TOKEN for Wrangler OAuth', async () => {
    expect(formatSql("SELECT '?' AS q, ? AS val", ["it's ok"])).toBe("SELECT '?' AS q, 'it''s ok' AS val");
    const calls: { command: string; token: string | undefined; home: string | undefined }[] = [];
    const db = createWranglerD1(
      (command, env) => {
        calls.push({ command, token: env.CLOUDFLARE_API_TOKEN, home: env.HOME });
        return JSON.stringify([{ results: [], meta: { changes: 0 } }, { results: [], meta: { changes: 0 } }]);
      },
      { CLOUDFLARE_API_TOKEN: 'stale-token-must-not-leak', HOME: '/home/tester' }
    );
    await db.batch([
      db.prepare("UPDATE story_ids SET url = ? WHERE url = ?").bind('https://news.pr/story/a', 'https://news.pr/story/a/'),
      db.prepare("DELETE FROM image_enrich_queue WHERE url = ?").bind('https://news.pr/story/a/'),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].token).toBeUndefined();
    expect(calls[0].home).toBe('/home/tester');
    expect(calls[0].command).toContain("UPDATE story_ids SET url = 'https://news.pr/story/a'");
  });
});

describe('repairNewsprUrls against D1 schema and triggers', () => {
  it('leaves every table untouched in dry-run mode and repairs all 8 tables + FTS cleanly on --apply', async () => {
    const { sql, DB } = setupDb();
    const oldUrl = 'https://news.pr/story/0348dd55e67a4a92ac82e8bb0abe2c6a/';
    const newUrl = 'https://news.pr/story/0348dd55e67a4a92ac82e8bb0abe2c6a';
    const controlUrl = 'https://www.noticel.com/economia/puerto-rico-energia/';

    const legacyItem = makeItem(
      oldUrl,
      'LUMA Energy schedules grid works across 14 municipalities',
      'Planned maintenance outages affect service across the island on Friday.'
    );
    const esTrans = makeSpanishTranslation(
      legacyItem,
      'LUMA Energy programa trabajos en la red eléctrica de 14 municipios',
      'Las interrupciones programadas por mantenimiento afectarán el servicio en la isla el viernes.'
    );
    insertArticle(sql, legacyItem, { firstSeen: NOW - 3 * HOUR, translation: esTrans });
    insertArticle(sql, makeItem(controlUrl, 'Noticia local de energía', 'Resumen de control en español.', 'noticel'));

    const originalStoryId = (sql.prepare('SELECT id FROM story_ids WHERE url = ?').get(oldUrl) as { id: number }).id;
    const archiveCountBefore = (sql.prepare('SELECT COUNT(*) AS n FROM archive_revisions WHERE source = ?').get('newspr') as { n: number }).n;
    expect(archiveCountBefore).toBe(1);

    // Seed clicks, alerts, and 404 image_enrich_queue failure on oldUrl (plus control rows).
    const bucket = Math.floor(NOW / 1000);
    sql.prepare('INSERT INTO article_click_buckets(url,bucket,clicks) VALUES(?,?,?)').run(oldUrl, bucket, 4);
    sql.prepare('INSERT INTO article_click_totals(url,clicks,updated_at) VALUES(?,?,?)').run(oldUrl, 4, bucket);
    sql.prepare('INSERT INTO site_click_totals(id,clicks,updated_at,started_at) VALUES(1,4,?,?) ON CONFLICT(id) DO UPDATE SET clicks=4').run(bucket, NOW - 10 * HOUR);

    insertAccount(sql, 'acct-1', 'one@example.com');
    sql.prepare('INSERT INTO alert_notified(account_id,url,notified_at) VALUES(?,?,?)').run('acct-1', oldUrl, NOW - HOUR);
    sql.prepare('INSERT INTO alert_queue(id,account_id,url,payload,enqueued_at) VALUES(?,?,?,?,?)').run(
      'q-1',
      'acct-1',
      oldUrl,
      JSON.stringify({ url: oldUrl, title: legacyItem.title, summary: legacyItem.summary, source: 'newspr', phrases: ['luma'] }),
      NOW - HOUR
    );
    sql.prepare('INSERT INTO image_enrich_queue(url,attempts,next_attempt,error) VALUES(?,?,?,?)').run(
      oldUrl,
      4,
      NOW + 365 * 86400_000,
      'Article page unavailable or not HTML (404, text/html)'
    );
    sql.prepare('INSERT INTO image_enrich_queue(url,attempts,next_attempt,error) VALUES(?,?,?,?)').run(
      controlUrl,
      1,
      NOW + HOUR,
      'No usable og:image metadata from publisher'
    );

    // 1. Dry run: reports counts accurately and mutates nothing.
    const dry = await repairNewsprUrls(DB, false);
    expect(dry.mode).toBe('dry-run');
    expect(dry.legacyUrlsFound).toBe(1);
    expect(dry.tables.articles).toEqual({ legacyRows: 1, updated: 0, merged: 0, deleted: 0 });
    expect(dry.tables.archive_revisions).toEqual({ legacyRows: 1, updated: 0 });
    expect(dry.tables.story_ids).toEqual({ legacyRows: 1, updated: 0, deleted: 0 });
    expect(dry.tables.article_click_totals).toEqual({ legacyRows: 1, updated: 0, merged: 0, deleted: 0 });
    expect(dry.tables.article_click_buckets).toEqual({ legacyRows: 1, upserted: 0, deleted: 0 });
    expect(dry.tables.alert_notified).toEqual({ legacyRows: 1, inserted: 0, deleted: 0 });
    expect(dry.tables.alert_queue).toEqual({ legacyRows: 1, updated: 0, deleted: 0 });
    expect(dry.tables.image_enrich_queue).toEqual({ legacyRows: 1, deleted: 0 });
    expect(sql.prepare('SELECT url FROM articles WHERE url = ?').get(oldUrl)).toBeTruthy();

    // 2. Apply: migrates all 8 tables + FTS without duplicate archive revisions.
    const applied = await repairNewsprUrls(DB, true);
    expect(applied.mode).toBe('apply');
    expect(applied.legacyUrlsFound).toBe(1);
    expect(applied.tables.articles).toEqual({ legacyRows: 1, updated: 1, merged: 0, deleted: 0 });
    expect(applied.tables.archive_revisions).toEqual({ legacyRows: 1, updated: 1 });
    expect(applied.tables.story_ids).toEqual({ legacyRows: 1, updated: 1, deleted: 0 });
    expect(applied.tables.article_click_totals).toEqual({ legacyRows: 1, updated: 1, merged: 0, deleted: 0 });
    expect(applied.tables.article_click_buckets).toEqual({ legacyRows: 1, upserted: 1, deleted: 1 });
    expect(applied.tables.alert_notified).toEqual({ legacyRows: 1, inserted: 1, deleted: 1 });
    expect(applied.tables.alert_queue).toEqual({ legacyRows: 1, updated: 1, deleted: 0 });
    expect(applied.tables.image_enrich_queue).toEqual({ legacyRows: 1, deleted: 1 });

    // Verify articles & payload & translation & first_seen
    expect(sql.prepare('SELECT COUNT(*) AS n FROM articles WHERE url = ?').get(oldUrl)).toEqual({ n: 0 });
    const repairedArticle = sql.prepare('SELECT url, payload, first_seen, translation FROM articles WHERE url = ?').get(newUrl) as {
      url: string;
      payload: string;
      first_seen: number;
      translation: string;
    };
    expect(repairedArticle.url).toBe(newUrl);
    expect((JSON.parse(repairedArticle.payload) as Item).url).toBe(newUrl);
    expect(repairedArticle.first_seen).toBe(NOW - 3 * HOUR);
    expect(JSON.parse(repairedArticle.translation)).toEqual(esTrans);

    // Verify FTS has 0 oldUrl rows and indexes both original + translation under newUrl
    expect(sql.prepare('SELECT COUNT(*) AS n FROM articles_fts WHERE url = ?').get(oldUrl)).toEqual({ n: 0 });
    expect(sql.prepare('SELECT url FROM articles_fts WHERE articles_fts MATCH ?').all('municipalities')).toEqual([{ url: newUrl }]);
    expect(sql.prepare('SELECT url FROM articles_fts WHERE articles_fts MATCH ?').all('municipios')).toEqual([{ url: newUrl }]);

    // Verify archive_revisions updated in place with NO duplicate revision emitted
    const revisions = sql.prepare('SELECT url, payload FROM archive_revisions WHERE source = ?').all('newspr') as { url: string; payload: string }[];
    expect(revisions).toHaveLength(1);
    expect(revisions[0].url).toBe(newUrl);
    expect((JSON.parse(revisions[0].payload) as Item).url).toBe(newUrl);

    // Verify story_ids preserved exact ID
    expect(sql.prepare('SELECT id, url FROM story_ids WHERE id = ?').get(originalStoryId)).toEqual({ id: originalStoryId, url: newUrl });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM story_ids WHERE url = ?').get(oldUrl)).toEqual({ n: 0 });

    // Verify clicks & site totals
    expect(sql.prepare('SELECT url, clicks, updated_at FROM article_click_totals WHERE url = ?').get(newUrl)).toEqual({
      url: newUrl,
      clicks: 4,
      updated_at: bucket,
    });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM article_click_totals WHERE url = ?').get(oldUrl)).toEqual({ n: 0 });
    expect(sql.prepare('SELECT url, bucket, clicks FROM article_click_buckets WHERE url = ?').all(newUrl)).toEqual([
      { url: newUrl, bucket, clicks: 4 },
    ]);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM article_click_buckets WHERE url = ?').get(oldUrl)).toEqual({ n: 0 });
    expect(sql.prepare('SELECT clicks FROM site_click_totals WHERE id = 1').get()).toEqual({ clicks: 4 });

    // Verify alerts
    expect(sql.prepare('SELECT account_id, url FROM alert_notified').all()).toEqual([{ account_id: 'acct-1', url: newUrl }]);
    const queued = sql.prepare('SELECT url, payload FROM alert_queue WHERE id = ?').get('q-1') as { url: string; payload: string };
    expect(queued.url).toBe(newUrl);
    expect(JSON.parse(queued.payload).url).toBe(newUrl);

    // Verify non-news.pr control rows stayed untouched
    expect(sql.prepare('SELECT url FROM articles WHERE url = ?').get(controlUrl)).toEqual({ url: controlUrl });
    expect(sql.prepare('SELECT url FROM image_enrich_queue').all()).toEqual([{ url: controlUrl }]);

    // Verify enrichImages naturally re-enqueues and enriches newUrl now that oldUrl 404 entry is gone
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) =>
        new Response(
          `<!doctype html><html><head><meta property="og:image" content="https://news.pr/story-art/0348dd55e67a4a92ac82e8bb0abe2c6a"></head></html>`,
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
        )
      )
    );
    const enrichRes = await enrichImages({ DB } as unknown as Env, NOW);
    expect(enrichRes).toMatchObject({ queued: 1, enriched: 1 });
    const withImage = JSON.parse(
      (sql.prepare('SELECT payload FROM articles WHERE url = ?').get(newUrl) as { payload: string }).payload
    ) as Item;
    expect(withImage.image).toBe('https://news.pr/story-art/0348dd55e67a4a92ac82e8bb0abe2c6a');
  });

  it('merges racing-cron collisions cleanly across all tables and is idempotent on repeat runs', async () => {
    const { sql, DB } = setupDb();
    const oldUrl = 'https://news.pr/story/bea62f0f40cb450ab392597801a15cc4/';
    const newUrl = 'https://news.pr/story/bea62f0f40cb450ab392597801a15cc4';

    const title = 'Casa Pueblo holds energy protest at El Morro on anniversary';
    const summary = 'Organizers called for rooftop solar investment across mountain towns.';
    const oldItem = makeItem(oldUrl, title, summary, 'newspr', NOW - 2 * HOUR);
    const newItem = makeItem(newUrl, title, summary, 'newspr', NOW - 2 * HOUR);
    const validSpanish = makeSpanishTranslation(
      newItem,
      'Casa Pueblo realiza protesta energética en El Morro en el aniversario',
      'Los organizadores pidieron inversión en energía solar en los techos de los pueblos de la montaña.'
    );

    // Pre-existing legacy row (earlier first_seen, completed Spanish translation)
    insertArticle(sql, oldItem, { firstSeen: NOW - 4 * HOUR, updatedAt: NOW - 4 * HOUR, translation: validSpanish });
    // Racing post-fix cron row (later first_seen, not yet translated)
    insertArticle(sql, newItem, { firstSeen: NOW - HOUR, updatedAt: NOW - HOUR, translation: null });

    const newStoryId = (sql.prepare('SELECT id FROM story_ids WHERE url = ?').get(newUrl) as { id: number }).id;
    const archiveBefore = (sql.prepare('SELECT COUNT(*) AS n FROM archive_revisions').get() as { n: number }).n;
    expect(archiveBefore).toBe(2); // 1 from oldItem insert + 1 from racing newItem insert

    // Overlapping and distinct clicks
    const b1 = Math.floor((NOW - 2 * HOUR) / 1000);
    const b2 = Math.floor((NOW - HOUR) / 1000);
    sql.prepare('INSERT INTO article_click_buckets(url,bucket,clicks) VALUES(?,?,?)').run(oldUrl, b1, 3);
    sql.prepare('INSERT INTO article_click_buckets(url,bucket,clicks) VALUES(?,?,?)').run(oldUrl, b2, 2);
    sql.prepare('INSERT INTO article_click_buckets(url,bucket,clicks) VALUES(?,?,?)').run(newUrl, b2, 5);
    sql.prepare('INSERT INTO article_click_totals(url,clicks,updated_at) VALUES(?,?,?)').run(oldUrl, 5, b2);
    sql.prepare('INSERT INTO article_click_totals(url,clicks,updated_at) VALUES(?,?,?)').run(newUrl, 5, b2 + 30);

    // Overlapping and distinct alert accounts
    insertAccount(sql, 'acct-both', 'both@example.com');
    insertAccount(sql, 'acct-old-only', 'old@example.com');
    sql.prepare('INSERT INTO alert_notified(account_id,url,notified_at) VALUES(?,?,?)').run('acct-both', oldUrl, NOW - 3 * HOUR);
    sql.prepare('INSERT INTO alert_notified(account_id,url,notified_at) VALUES(?,?,?)').run('acct-both', newUrl, NOW - HOUR);
    sql.prepare('INSERT INTO alert_notified(account_id,url,notified_at) VALUES(?,?,?)').run('acct-old-only', oldUrl, NOW - 3 * HOUR);

    sql.prepare('INSERT INTO alert_queue(id,account_id,url,payload,enqueued_at) VALUES(?,?,?,?,?)').run(
      'q-both-old',
      'acct-both',
      oldUrl,
      JSON.stringify({ url: oldUrl, title, summary, source: 'newspr', phrases: ['solar'] }),
      NOW - 3 * HOUR
    );
    sql.prepare('INSERT INTO alert_queue(id,account_id,url,payload,enqueued_at) VALUES(?,?,?,?,?)').run(
      'q-both-new',
      'acct-both',
      newUrl,
      JSON.stringify({ url: newUrl, title, summary, source: 'newspr', phrases: ['solar'] }),
      NOW - HOUR
    );
    sql.prepare('INSERT INTO alert_queue(id,account_id,url,payload,enqueued_at) VALUES(?,?,?,?,?)').run(
      'q-old-only',
      'acct-old-only',
      oldUrl,
      JSON.stringify({ url: oldUrl, title, summary, source: 'newspr', phrases: ['morro'] }),
      NOW - 3 * HOUR
    );
    sql.prepare('INSERT INTO image_enrich_queue(url,attempts,next_attempt,error) VALUES(?,?,?,?)').run(
      oldUrl,
      3,
      NOW + HOUR,
      'Article page unavailable or not HTML (404, text/html)'
    );

    const firstRun = await repairNewsprUrls(DB, true);
    expect(firstRun.tables.articles).toEqual({ legacyRows: 1, updated: 0, merged: 1, deleted: 1 });
    expect(firstRun.tables.story_ids).toEqual({ legacyRows: 1, updated: 0, deleted: 1 });
    expect(firstRun.tables.article_click_totals).toEqual({ legacyRows: 1, updated: 0, merged: 1, deleted: 1 });

    // Merged article kept earliest first_seen and valid Spanish translation; oldUrl gone
    expect(sql.prepare('SELECT COUNT(*) AS n FROM articles WHERE url = ?').get(oldUrl)).toEqual({ n: 0 });
    const mergedArticle = sql.prepare('SELECT first_seen, translation FROM articles WHERE url = ?').get(newUrl) as {
      first_seen: number;
      translation: string;
    };
    expect(mergedArticle.first_seen).toBe(NOW - 4 * HOUR);
    expect(JSON.parse(mergedArticle.translation)).toEqual(validSpanish);

    // FTS clean: 0 oldUrl rows, 1 newUrl row with merged Spanish translation searchable
    expect(sql.prepare('SELECT COUNT(*) AS n FROM articles_fts WHERE url = ?').get(oldUrl)).toEqual({ n: 0 });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM articles_fts WHERE url = ?').get(newUrl)).toEqual({ n: 1 });
    expect(sql.prepare('SELECT url FROM articles_fts WHERE articles_fts MATCH ?').all('energética')).toEqual([{ url: newUrl }]);

    // Archive revisions: no duplicate revision emitted by merge
    expect((sql.prepare('SELECT COUNT(*) AS n FROM archive_revisions').get() as { n: number }).n).toBe(archiveBefore);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM archive_revisions WHERE url = ?').get(oldUrl)).toEqual({ n: 0 });

    // story_ids: kept newUrl's row, deleted oldUrl
    expect(sql.prepare('SELECT id, url FROM story_ids').all()).toEqual([{ id: newStoryId, url: newUrl }]);

    // Clicks: summed totals & merged buckets
    expect(sql.prepare('SELECT url, clicks, updated_at FROM article_click_totals').all()).toEqual([
      { url: newUrl, clicks: 10, updated_at: b2 + 30 },
    ]);
    expect(sql.prepare('SELECT url, bucket, clicks FROM article_click_buckets ORDER BY bucket ASC').all()).toEqual([
      { url: newUrl, bucket: b1, clicks: 3 },
      { url: newUrl, bucket: b2, clicks: 7 },
    ]);

    // Alerts & enrich queue: 0 oldUrl rows anywhere
    expect(sql.prepare('SELECT account_id, url FROM alert_notified ORDER BY account_id ASC').all()).toEqual([
      { account_id: 'acct-both', url: newUrl },
      { account_id: 'acct-old-only', url: newUrl },
    ]);
    const alertQueueRows = sql.prepare('SELECT id, account_id, url, payload FROM alert_queue ORDER BY account_id ASC').all() as {
      id: string;
      account_id: string;
      url: string;
      payload: string;
    }[];
    expect(alertQueueRows.map(r => [r.id, r.account_id, r.url, JSON.parse(r.payload).url])).toEqual([
      ['q-both-new', 'acct-both', newUrl, newUrl],
      ['q-old-only', 'acct-old-only', newUrl, newUrl],
    ]);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM image_enrich_queue').get()).toEqual({ n: 0 });

    // Second run is a strict idempotent no-op
    const secondRun = await repairNewsprUrls(DB, true);
    expect(secondRun.legacyUrlsFound).toBe(0);
    expect(secondRun.tables).toEqual({
      articles: { legacyRows: 0, updated: 0, merged: 0, deleted: 0 },
      archive_revisions: { legacyRows: 0, updated: 0 },
      story_ids: { legacyRows: 0, updated: 0, deleted: 0 },
      article_click_totals: { legacyRows: 0, updated: 0, merged: 0, deleted: 0 },
      article_click_buckets: { legacyRows: 0, upserted: 0, deleted: 0 },
      alert_notified: { legacyRows: 0, inserted: 0, deleted: 0 },
      alert_queue: { legacyRows: 0, updated: 0, deleted: 0 },
      image_enrich_queue: { legacyRows: 0, deleted: 0 },
    });
  });
});
