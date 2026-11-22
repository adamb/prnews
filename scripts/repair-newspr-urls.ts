// One-time, idempotent, guarded D1 repair for legacy trailing-slash news.pr URLs
// (`https://news.pr/<non-root>/` -> `https://news.pr/<non-root>`).
//
// Dry run is the default and performs zero writes. Pass `--apply` to mutate
// remote D1 via the Wrangler CLI using Wrangler OAuth (`CLOUDFLARE_API_TOKEN`
// is unset in the child process environment, matching scripts/repair-language.ts).
//
// Usage:
//   npx tsx scripts/repair-newspr-urls.ts [--apply]
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { canonical, type Item } from '../src/parse';
import { isEnglishItem } from '../src/sources';
import { validSpanishTranslation, validTranslation, type Translation } from '../src/i18n';

const NEWSPR_PREFIX = 'https://news.pr/%';
const NEWSPR_ROOT = 'https://news.pr/';

/** Returns the slashless canonical news.pr URL iff `oldUrl` is a legacy trailing-slash non-root news.pr URL. */
export function canonicalNewsprRepairTarget(oldUrl: string): string | null {
  if (!oldUrl.startsWith(NEWSPR_ROOT)) return null;
  let u: URL;
  try {
    u = new URL(oldUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'news.pr' || u.port !== '' || u.username || u.password) return null;
  if (!u.pathname.endsWith('/') || u.pathname.replace(/\/+$/, '') === '') return null;
  const next = canonical(oldUrl, 'https://news.pr');
  if (!next || next === oldUrl || next === NEWSPR_ROOT) return null;
  return next;
}

function isValidStoredTranslation(item: Item, raw: string | null): boolean {
  if (!raw) return false;
  try {
    const entry = JSON.parse(raw) as Translation;
    return isEnglishItem(item) ? validSpanishTranslation(item, entry) : validTranslation(item, entry);
  } catch {
    return false;
  }
}

export interface RepairNewsprSummary {
  mode: 'dry-run' | 'apply';
  legacyUrlsFound: number;
  tables: {
    articles: { legacyRows: number; updated: number; merged: number; deleted: number };
    archive_revisions: { legacyRows: number; updated: number };
    story_ids: { legacyRows: number; updated: number; deleted: number };
    article_click_totals: { legacyRows: number; updated: number; merged: number; deleted: number };
    article_click_buckets: { legacyRows: number; upserted: number; deleted: number };
    alert_notified: { legacyRows: number; inserted: number; deleted: number };
    alert_queue: { legacyRows: number; updated: number; deleted: number };
    image_enrich_queue: { legacyRows: number; deleted: number };
  };
  examples: Array<{ oldUrl: string; newUrl: string }>;
}

interface ArticleRow {
  url: string;
  payload: string;
  first_seen: number;
  translation: string | null;
}

/**
 * Scans all URL-bearing tables for legacy `https://news.pr/<non-root>/` rows and,
 * when `apply === true`, repairs them idempotently without duplicate archive revisions
 * or orphaned FTS rows. When `apply === false` (default), performs read-only queries only.
 */
export async function repairNewsprUrls(db: D1Database, apply: boolean = false): Promise<RepairNewsprSummary> {
  const summary: RepairNewsprSummary = {
    mode: apply ? 'apply' : 'dry-run',
    legacyUrlsFound: 0,
    tables: {
      articles: { legacyRows: 0, updated: 0, merged: 0, deleted: 0 },
      archive_revisions: { legacyRows: 0, updated: 0 },
      story_ids: { legacyRows: 0, updated: 0, deleted: 0 },
      article_click_totals: { legacyRows: 0, updated: 0, merged: 0, deleted: 0 },
      article_click_buckets: { legacyRows: 0, upserted: 0, deleted: 0 },
      alert_notified: { legacyRows: 0, inserted: 0, deleted: 0 },
      alert_queue: { legacyRows: 0, updated: 0, deleted: 0 },
      image_enrich_queue: { legacyRows: 0, deleted: 0 },
    },
    examples: [],
  };

  const urlMap = new Map<string, string>();
  const recordUrl = (oldUrl: string): string | null => {
    const existing = urlMap.get(oldUrl);
    if (existing) return existing;
    const next = canonicalNewsprRepairTarget(oldUrl);
    if (next) urlMap.set(oldUrl, next);
    return next;
  };

  // 1. articles (maintains articles_fts via triggers without firing archive_changed_article)
  const articleRows = (await db.prepare(
    'SELECT url, payload, first_seen, translation FROM articles WHERE url LIKE ? AND url != ? ORDER BY url ASC'
  ).bind(NEWSPR_PREFIX, NEWSPR_ROOT).all<ArticleRow>()).results;
  for (const oldRow of articleRows) {
    const newUrl = recordUrl(oldRow.url);
    if (!newUrl) continue;
    summary.tables.articles.legacyRows++;
    if (!apply) continue;

    let existingNew = await db.prepare(
      'SELECT url, payload, first_seen, translation FROM articles WHERE url = ?'
    ).bind(newUrl).first<ArticleRow>();

    if (!existingNew) {
      const upd = await db.prepare(
        "UPDATE articles SET url = ?, payload = json_set(payload, '$.url', ?) WHERE url = ? AND NOT EXISTS (SELECT 1 FROM articles WHERE url = ?)"
      ).bind(newUrl, newUrl, oldRow.url, newUrl).run();
      if (Number(upd.meta.changes) > 0) {
        summary.tables.articles.updated += Number(upd.meta.changes);
        continue;
      }
      existingNew = await db.prepare(
        'SELECT url, payload, first_seen, translation FROM articles WHERE url = ?'
      ).bind(newUrl).first<ArticleRow>();
    }

    if (existingNew) {
      const earliestFirstSeen = Math.min(existingNew.first_seen, oldRow.first_seen);
      const newItem = JSON.parse(existingNew.payload) as Item;
      const newHasValid = isValidStoredTranslation(newItem, existingNew.translation);
      const oldHasValid = !newHasValid && isValidStoredTranslation(newItem, oldRow.translation);
      const statements: D1PreparedStatement[] = [];
      if (oldHasValid) {
        statements.push(
          db.prepare('UPDATE articles SET first_seen = MIN(first_seen, ?), translation = ? WHERE url = ?')
            .bind(earliestFirstSeen, oldRow.translation, newUrl)
        );
      } else if (earliestFirstSeen < existingNew.first_seen) {
        statements.push(
          db.prepare('UPDATE articles SET first_seen = MIN(first_seen, ?) WHERE url = ?')
            .bind(earliestFirstSeen, newUrl)
        );
      }
      statements.push(
        db.prepare('DELETE FROM articles WHERE url = ? AND EXISTS (SELECT 1 FROM articles WHERE url = ?)')
          .bind(oldRow.url, newUrl)
      );
      const batchRes = await db.batch(statements);
      const deleted = Number(batchRes[batchRes.length - 1]?.meta.changes ?? 0);
      if (deleted > 0) {
        summary.tables.articles.merged++;
        summary.tables.articles.deleted += deleted;
      }
    }
  }

  // 2. archive_revisions
  const archiveGroups = (await db.prepare(
    'SELECT url, COUNT(*) AS n FROM archive_revisions WHERE url LIKE ? AND url != ? GROUP BY url ORDER BY url ASC'
  ).bind(NEWSPR_PREFIX, NEWSPR_ROOT).all<{ url: string; n: number }>()).results;
  for (const group of archiveGroups) {
    const newUrl = recordUrl(group.url);
    if (!newUrl) continue;
    summary.tables.archive_revisions.legacyRows += Number(group.n);
    if (!apply) continue;
    const upd = await db.prepare(
      "UPDATE archive_revisions SET url = ?, payload = json_set(payload, '$.url', ?) WHERE url = ?"
    ).bind(newUrl, newUrl, group.url).run();
    summary.tables.archive_revisions.updated += Number(upd.meta.changes);
  }

  // 3. story_ids (preserve existing id when possible; drop oldUrl if newUrl already has an id)
  const storyRows = (await db.prepare(
    'SELECT id, url FROM story_ids WHERE url LIKE ? AND url != ? ORDER BY id ASC'
  ).bind(NEWSPR_PREFIX, NEWSPR_ROOT).all<{ id: number; url: string }>()).results;
  for (const row of storyRows) {
    const newUrl = recordUrl(row.url);
    if (!newUrl) continue;
    summary.tables.story_ids.legacyRows++;
    if (!apply) continue;
    const [upd, del] = await db.batch([
      db.prepare('UPDATE OR IGNORE story_ids SET url = ? WHERE id = ? AND url = ?').bind(newUrl, row.id, row.url),
      db.prepare('DELETE FROM story_ids WHERE id = ? AND url = ? AND EXISTS (SELECT 1 FROM story_ids WHERE url = ?)').bind(row.id, row.url, newUrl),
    ]);
    summary.tables.story_ids.updated += Number(upd.meta.changes);
    summary.tables.story_ids.deleted += Number(del.meta.changes);
  }

  // 4. article_click_totals
  const totalRows = (await db.prepare(
    'SELECT url FROM article_click_totals WHERE url LIKE ? AND url != ? ORDER BY url ASC'
  ).bind(NEWSPR_PREFIX, NEWSPR_ROOT).all<{ url: string }>()).results;
  for (const row of totalRows) {
    const newUrl = recordUrl(row.url);
    if (!newUrl) continue;
    summary.tables.article_click_totals.legacyRows++;
    if (!apply) continue;
    const upd = await db.prepare('UPDATE OR IGNORE article_click_totals SET url = ? WHERE url = ?')
      .bind(newUrl, row.url).run();
    if (Number(upd.meta.changes) > 0) {
      summary.tables.article_click_totals.updated += Number(upd.meta.changes);
      continue;
    }
    const [, del] = await db.batch([
      db.prepare(
        `INSERT INTO article_click_totals(url, clicks, updated_at)
         SELECT ?, clicks, updated_at FROM article_click_totals WHERE url = ?
         ON CONFLICT(url) DO UPDATE SET
           clicks = article_click_totals.clicks + excluded.clicks,
           updated_at = MAX(article_click_totals.updated_at, excluded.updated_at)`
      ).bind(newUrl, row.url),
      db.prepare('DELETE FROM article_click_totals WHERE url = ? AND EXISTS (SELECT 1 FROM article_click_totals WHERE url = ?)')
        .bind(row.url, newUrl),
    ]);
    const deleted = Number(del.meta.changes);
    if (deleted > 0) {
      summary.tables.article_click_totals.merged++;
      summary.tables.article_click_totals.deleted += deleted;
    }
  }

  // 5. article_click_buckets
  const bucketGroups = (await db.prepare(
    'SELECT url, COUNT(*) AS n FROM article_click_buckets WHERE url LIKE ? AND url != ? GROUP BY url ORDER BY url ASC'
  ).bind(NEWSPR_PREFIX, NEWSPR_ROOT).all<{ url: string; n: number }>()).results;
  for (const group of bucketGroups) {
    const newUrl = recordUrl(group.url);
    if (!newUrl) continue;
    summary.tables.article_click_buckets.legacyRows += Number(group.n);
    if (!apply) continue;
    const [ins, del] = await db.batch([
      db.prepare(
        `INSERT INTO article_click_buckets(url, bucket, clicks)
         SELECT ?, bucket, clicks FROM article_click_buckets WHERE url = ?
         ON CONFLICT(url, bucket) DO UPDATE SET clicks = article_click_buckets.clicks + excluded.clicks`
      ).bind(newUrl, group.url),
      db.prepare('DELETE FROM article_click_buckets WHERE url = ?').bind(group.url),
    ]);
    summary.tables.article_click_buckets.upserted += Number(ins.meta.changes);
    summary.tables.article_click_buckets.deleted += Number(del.meta.changes);
  }

  // 6. alert_notified
  const notifiedGroups = (await db.prepare(
    'SELECT url, COUNT(*) AS n FROM alert_notified WHERE url LIKE ? AND url != ? GROUP BY url ORDER BY url ASC'
  ).bind(NEWSPR_PREFIX, NEWSPR_ROOT).all<{ url: string; n: number }>()).results;
  for (const group of notifiedGroups) {
    const newUrl = recordUrl(group.url);
    if (!newUrl) continue;
    summary.tables.alert_notified.legacyRows += Number(group.n);
    if (!apply) continue;
    const [ins, del] = await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO alert_notified(account_id, url, notified_at)
         SELECT account_id, ?, notified_at FROM alert_notified WHERE url = ?`
      ).bind(newUrl, group.url),
      db.prepare('DELETE FROM alert_notified WHERE url = ?').bind(group.url),
    ]);
    summary.tables.alert_notified.inserted += Number(ins.meta.changes);
    summary.tables.alert_notified.deleted += Number(del.meta.changes);
  }

  // 7. alert_queue
  const alertQueueGroups = (await db.prepare(
    'SELECT url, COUNT(*) AS n FROM alert_queue WHERE url LIKE ? AND url != ? GROUP BY url ORDER BY url ASC'
  ).bind(NEWSPR_PREFIX, NEWSPR_ROOT).all<{ url: string; n: number }>()).results;
  for (const group of alertQueueGroups) {
    const newUrl = recordUrl(group.url);
    if (!newUrl) continue;
    summary.tables.alert_queue.legacyRows += Number(group.n);
    if (!apply) continue;
    const [upd, del] = await db.batch([
      db.prepare("UPDATE OR IGNORE alert_queue SET url = ?, payload = json_set(payload, '$.url', ?) WHERE url = ?")
        .bind(newUrl, newUrl, group.url),
      db.prepare('DELETE FROM alert_queue WHERE url = ?').bind(group.url),
    ]);
    summary.tables.alert_queue.updated += Number(upd.meta.changes);
    summary.tables.alert_queue.deleted += Number(del.meta.changes);
  }

  // 8. image_enrich_queue (drop 404 trailing-slash entries so enrichImages re-enqueues newUrl cleanly)
  const enrichRows = (await db.prepare(
    'SELECT url FROM image_enrich_queue WHERE url LIKE ? AND url != ? ORDER BY url ASC'
  ).bind(NEWSPR_PREFIX, NEWSPR_ROOT).all<{ url: string }>()).results;
  for (const row of enrichRows) {
    const newUrl = recordUrl(row.url);
    if (!newUrl) continue;
    summary.tables.image_enrich_queue.legacyRows++;
    if (!apply) continue;
    const del = await db.prepare('DELETE FROM image_enrich_queue WHERE url = ?').bind(row.url).run();
    summary.tables.image_enrich_queue.deleted += Number(del.meta.changes);
  }

  summary.legacyUrlsFound = urlMap.size;
  summary.examples = [...urlMap.entries()].slice(0, 10).map(([oldUrl, newUrl]) => ({ oldUrl, newUrl }));
  return summary;
}

const sqlLiteral = (v: unknown): string => {
  if (v == null) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Non-finite SQL number: ${v}`);
    return String(v);
  }
  return `'` + String(v).replaceAll(`'`, `''`) + `'`;
};

/** Substitutes `?` bind placeholders outside single-quoted SQL string literals. */
export function formatSql(sql: string, args: unknown[]): string {
  let argIndex = 0;
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === `'`) {
      out += ch;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === `'` && sql[i + 1] === `'`) {
          out += sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === `'`) break;
        i++;
      }
    } else if (ch === '?') {
      if (argIndex >= args.length) throw new Error(`Missing SQL bind parameter at index ${argIndex}`);
      out += sqlLiteral(args[argIndex++]);
    } else {
      out += ch;
    }
  }
  if (argIndex !== args.length) throw new Error(`Unused SQL bind parameters: expected ${argIndex}, got ${args.length}`);
  return out;
}

export type WranglerExec = (command: string, env: NodeJS.ProcessEnv) => string;

const defaultWranglerExec: WranglerExec = (command, env) =>
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'prnews', '--remote', '--json', '--command', command], {
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

/** Remote D1 adapter via Wrangler CLI using Wrangler OAuth (unsets CLOUDFLARE_API_TOKEN). */
export function createWranglerD1(exec: WranglerExec = defaultWranglerExec, baseEnv: NodeJS.ProcessEnv = process.env): D1Database {
  const executeRaw = (command: string): Array<{ results?: unknown[]; meta?: { changes?: number } }> => {
    const env = { ...baseEnv };
    delete env.CLOUDFLARE_API_TOKEN;
    const stdout = exec(command, env).replace(/^[\s\S]*?(?=\[\s*\{)/, '');
    return JSON.parse(stdout);
  };

  function prepare(sql: string) {
    let args: unknown[] = [];
    const toSql = () => formatSql(sql, args).replace(/;\s*$/, '');
    const execOne = async () => {
      const res = executeRaw(toSql())[0] ?? {};
      return {
        results: (res.results ?? []) as any[],
        success: true,
        meta: { changes: Number(res.meta?.changes ?? 0) },
      };
    };
    return {
      toSql,
      bind(...values: unknown[]) {
        args = values;
        return this;
      },
      run: execOne,
      all: execOne,
      async first<T = unknown>(): Promise<T | null> {
        const res = await execOne();
        return (res.results[0] as T | undefined) ?? null;
      },
    };
  }

  return {
    prepare,
    async batch(statements: Array<{ toSql?: () => string; run: () => Promise<unknown> }>) {
      if (!statements.length) return [];
      const combined = statements.map(s => {
        if (typeof s.toSql !== 'function') throw new Error('Unsupported statement in Wrangler batch');
        return s.toSql();
      }).join(';\n') + ';';
      return executeRaw(combined).map(res => ({
        results: res.results ?? [],
        success: true,
        meta: { changes: Number(res.meta?.changes ?? 0) },
      }));
    },
  } as unknown as D1Database;
}

async function main(): Promise<void> {
  const args: string[] = process.argv.slice(2);
  const unknown = args.filter((a: string) => a !== '--apply' && a !== '--dry-run');
  if (unknown.length > 0 || (args.includes('--apply') && args.includes('--dry-run'))) {
    console.error('Usage: npx tsx scripts/repair-newspr-urls.ts [--apply]');
    process.exit(2);
  }
  const apply = args.includes('--apply');
  if (!apply) {
    process.stderr.write('Dry run (default): no production writes. Pass --apply to repair remote D1.\n');
  }
  const db = createWranglerD1();
  const result = await repairNewsprUrls(db, apply);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
