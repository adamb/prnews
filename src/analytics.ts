import analytics from './analytics.json';

/**
 * Cloudflare Web Analytics (RUM) read integration — official GraphQL Analytics API
 * (`rumPageloadEventsAdaptiveGroups`), read with the account's existing API token stored as
 * the `CF_ANALYTICS_TOKEN` worker secret. The token is never rendered, logged, or sent anywhere
 * but api.cloudflare.com.
 *
 * Two distinct identifiers matter and are NOT interchangeable (both verified live against the
 * account): `token` in analytics.json is the beacon snippet token embedded in pages; `siteTag`
 * is the per-property identifier the GraphQL filter needs. Filtering by the beacon token
 * returns silently-empty results instead of an error.
 *
 * Semantics, deliberately not confused with /click counts:
 * - `count` per group = browser pageloads (pageviews). The beacon only fires when JavaScript
 *   runs, so non-JS clients (bots, some feeds/previews) never enter the dataset.
 * - `sum { visits }` = visit sessions as RUM defines them — NOT unique visitor identities.
 *   No visitor IDs, IPs, or cookies are stored or invented by this worker.
 * - Worker requests (this Worker's fetch volume) are never part of this dataset.
 *
 * Caching is bounded: the scheduler refreshes at most once per TTL (cron probe is a single
 * cheap SELECT; the GraphQL fetch happens only when stale). Page renders read only D1, so no
 * Cloudflare API call happens per page view and stored day rows accumulate durably beyond the
 * API's own querying window (which currently spans at most ~13w2d back).
 */
export interface AnalyticsEnv { DB: D1Database; CF_ANALYTICS_TOKEN?: string }

export const ACCOUNT_TAG = analytics.account;
export const SITE_TAG = analytics.siteTag;
/** Site is tiny (tens of pageviews/day): an 8-day, date-dimension query can never hit the
 * adaptive-groups row limit, so totals are exact within the fetched window. */
export const ANALYTICS_WINDOW_DAYS = 8;
/** At most one fetch every 6 hours; each fetch is one GraphQL query. */
export const ANALYTICS_TTL_MS = 6 * 3600000;
export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
/** Dashboard entry point the error state links to, so the explanation is precise. */
export const dashboardUrl = `https://dash.cloudflare.com/${ACCOUNT_TAG}/web-analytics`;

export interface AnalyticsDay { date: string; pageviews: number; visits: number }
export interface AnalyticsSnapshot {
  /** False when the integration is unconfigured, errored, or has no stored day yet, with the honest reason. */
  available: boolean;
  reason?: 'unconfigured' | 'unavailable' | 'empty';
  days: AnalyticsDay[];
  totalPageviews: number;
  totalVisits: number;
  /** First stored day (YYYY-MM-DD) — the label for "measured since". */
  since?: string;
  fetchedAt: number | null;
}

const QUERY = `query($acct:String!,$site:String!,$from:Time!,$to:Time!){viewer{accounts(filter:{accountTag:$acct})`
 +`{pageloads:rumPageloadEventsAdaptiveGroups(limit:${ANALYTICS_WINDOW_DAYS},filter:{siteTag:$site,datetime_geq:$from,datetime_leq:$to},orderBy:[date_ASC])`
 +`{count sum{visits} dimensions{date}}}}}`;

interface GraphResponse { data?: { viewer?: { accounts?: { pageloads?: { count: number; sum: { visits: number }; dimensions: { date: string } }[] }[] } }; errors?: { message: string }[] }

/**
 * Scheduler-side refresh. Skips unless the stored snapshot is older than the TTL; reads the API
 * once otherwise and upserts each day. A day with no pageloads is simply absent from the
 * response (zero contributes nothing, totals stay correct). Failures never throw into cron —
 * callers keep the last cached snapshot and the rendered page explains availability.
 */
export async function refreshWebAnalytics(env: AnalyticsEnv, now: number = Date.now()): Promise<{ refreshed: boolean; reason?: string }> {
  if (!env.DB) return { refreshed: false, reason: 'no-db' };
  if (!env.CF_ANALYTICS_TOKEN) return { refreshed: false, reason: 'unconfigured' };
  const state = await env.DB.prepare('SELECT MAX(fetched_at) AS t FROM web_analytics_daily').first<{ t: number | null }>();
  if (!state) return { refreshed: false, reason: 'migration-pending' };
  if ((state.t ?? 0) > now - ANALYTICS_TTL_MS) return { refreshed: false, reason: 'fresh' };
  const from = new Date(now - ANALYTICS_WINDOW_DAYS * 86400000).toISOString().slice(0, 19) + 'Z';
  const to = new Date(now).toISOString().slice(0, 19) + 'Z';
  let payload: GraphResponse;
  try {
    const response = await fetch(GRAPHQL_URL, { method: 'POST', headers: { 'Authorization': `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: QUERY, variables: { acct: ACCOUNT_TAG, site: SITE_TAG, from, to } }), signal: AbortSignal.timeout(10000) });
    // GraphQL reports query failures as HTTP 200 + an errors array; treat both as failure.
    if (!response.ok) return { refreshed: false, reason: `http ${response.status}` };
    payload = (await response.json()) as GraphResponse;
    if (payload.errors?.length) return { refreshed: false, reason: 'graphql-error' };
  } catch { return { refreshed: false, reason: 'fetch-failed' }; }
  const rows = payload.data?.viewer?.accounts?.[0]?.pageloads ?? [];
  // Date-only grouping over an 8-day window yields ≤ 8 rows, so the adaptive-groups limit can
  // never silently truncate this query — no truncation check is needed (and a wrong one would
  // discard valid complete days). A day with no beacon pageloads at all is absent from the
  // response; if it is the running UTC day we store an honest 0/0 row so the refresh cursor
  // advances even during quiet periods (later fetches upsert its real count).
  const clean = rows.filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.dimensions.date) && Number.isInteger(r.count) && r.count >= 0 && Number.isInteger(r.sum.visits) && r.sum.visits >= 0);
  if (!clean.length) clean.push({ count: 0, sum: { visits: 0 }, dimensions: { date: to.slice(0, 10) } });
  // Fresher snapshot wins per day (same-day counts finalize shortly after midnight).
  await env.DB.batch(clean.map(r => env.DB.prepare('INSERT INTO web_analytics_daily(date,pageviews,visits,fetched_at) VALUES(?,?,?,?) ON CONFLICT(date) DO UPDATE SET pageviews=excluded.pageviews,visits=excluded.visits,fetched_at=excluded.fetched_at').bind(r.dimensions.date, r.count, r.sum.visits, now)));
  return { refreshed: true, reason: `ok ${clean.length}` };
}

/** Reader for rendering: D1-only, sums the stored archive. Always available state-safe. */
export async function webAnalyticsSnapshot(env: AnalyticsEnv): Promise<AnalyticsSnapshot> {
  const empty: AnalyticsSnapshot = { available: false, reason: 'unavailable', days: [], totalPageviews: 0, totalVisits: 0, fetchedAt: null };
  try {
    const rows = (await env.DB.prepare('SELECT date,pageviews,visits,fetched_at FROM web_analytics_daily ORDER BY date').all<AnalyticsDay & { fetched_at: number }>()).results;
    if (!rows.length) return { ...empty, reason: 'empty' };
    return {
      available: true,
      days: rows.map(r => ({ date: r.date, pageviews: r.pageviews, visits: r.visits })),
      totalPageviews: rows.reduce((n, r) => n + r.pageviews, 0),
      totalVisits: rows.reduce((n, r) => n + r.visits, 0),
      since: rows[0].date,
      fetchedAt: Math.max(...rows.map(r => r.fetched_at)),
    };
  } catch { return empty; }
}
