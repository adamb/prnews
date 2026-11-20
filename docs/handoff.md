# Handoff — 2026-11-20

State at the end of the previous thread. Read `README.md` and `AGENTS.md` first. `docs/releases.md` has per-deploy detail.

## Where things stand

- `main` is at `abf364d`, clean and pushed. Production Worker version is `11d5d9b5-4f75-4385-aa1e-4dbf742ad3db`, built from `a0df03e`.
- Everything the user asked for in the last thread is merged and deployed: per-source view (#31), satire guard (#32) and its relaxation (#34), icon-only theme button (#33), overflow fix (#36), hreflang/canonical/noindex plus sitemap (#35), single satire button label (#37), share-with-satire (#38).
- Nothing is pending from the user.
- Open PRs not touched in the last thread: #29 (Reddit image repair through Roux), #19 (News is my Business articles, Nov 16–19), #16 (keep News is my Business paused). Check them before building anything nearby.

## How work was run

The user wants the orchestrator to delegate coding to Grok Build child agents (`delegate_task`, provider instance `grok`, `isolation: "worktree"`), then review the diff, test, merge and deploy. Children never merge or deploy.

Release flow: `gh pr merge N --squash`, `git pull --ff-only`, `npm test`, `npm run typecheck`, `npm run build`, `npx wrangler deploy`, then append a note to `docs/releases.md` (commit SHA and Worker version) and push it to main. Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Facts worth knowing

- Cloudflare Worker (not Pages) with D1, R2, and a Cache API HTML cache. The cache name is `prnews-html-v36` with a 60 s TTL. Bump it in `src/index.ts` when page HTML changes, and add a unique query param when testing live.
- D1 can be queried read-only with `npx wrangler d1 execute prnews --remote --json`.
- Pages are rendered in `src/render.ts`; CSS is a string in `src/styles.ts`.
- SEO helpers are in `src/seo.ts`. The sitemap is served by `src/syndication.ts`; `src/discovery.ts` has a separate copy, so keep both on `seo.ts`.
- Satire is in `src/lighter.ts`.
  - `valid()` runs on write and on read, so tightening it hides stored lines without deleting them.
  - The cache key uses `VERSION='lighter-2'`. Do not bump it casually; that orphans every stored satire.
  - `inventedInstitution()` rejects a line that names an invented government, agency, ministry, department, committee, board or State. Generic stand-ins like "bureaucrats" are allowed on purpose, because the user liked the Indignation Day line.
- Share links: `src/share.ts`. The satire text is never put in the URL, only id, `satire=1` and `&lang=en`. `/story?id=N&satire=1` renders the satire pre-opened and is `noindex,follow` with the plain story URL as canonical.
- Screenshots and overflow checks: Playwright resolves from `/home/adam/code/hbpr/node_modules/playwright-core`. Don't use `pkill -f`.
- Tests: 477 passing at last release.

## Open items (not code, mostly the user's)

1. **Search Console "Deceptive pages" issue on `dev.pr`.** The domain property is verified through the DNS TXT record. The issue lists no sample URLs. Safe Browsing shows clean for `dev.pr` and `news.dev.pr`. Most likely cause is `spider.dev.pr` (public `/admin`, several apps) or the old placeholder apex page. The user is deleting the placeholder page and its Cloudflare A record. When they say it's done, recheck, then they click "Request review" in Search Console.
2. **Keep these DNS records:** `news` (the Worker), the `google-site-verification` TXT, and SPF/MX.
3. **Sitemap:** optionally have the user submit `https://news.dev.pr/sitemap.xml` in Search Console. It has 1,040 URLs as of the last check.
4. **Not verified for #38:** the native OS share sheet and how messaging apps cache previews. Suggested test: share `https://news.dev.pr/story?id=3381&lang=en&satire=1` to themselves. An app that cached a plain link earlier may keep the old preview.
5. **8 of 71 stored satires** fail the current guard and are hidden on read. They are not deleted. Revisit only if the user complains about missing satire.
