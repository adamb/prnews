# Handoff — 2026-11-20

State at the end of the previous thread. Read `README.md` and `AGENTS.md` first. `docs/releases.md` has per-deploy detail.

## Where things stand

- `main` is at `abf364d`, clean and pushed. Production Worker version is `11d5d9b5-4f75-4385-aa1e-4dbf742ad3db`, built from `a0df03e`.
- Everything the user asked for in the last thread is merged and deployed: per-source view (#31), satire guard (#32) and its relaxation (#34), icon-only theme button (#33), overflow fix (#36), hreflang/canonical/noindex plus sitemap (#35), single satire button label (#37), share-with-satire (#38).
- Nothing is pending from the user.
- Open PRs not touched in the last thread: #29 (Reddit image repair through Roux), #19 (News is my Business articles, Nov 16–19), #16 (keep News is my Business paused). Check them before building anything nearby.

## PR review outcomes (2026-11-20)

- **#29 merged** (squash `f324616`, head reviewed at `7cb160f` + integration merge `5bd83fd`). Tooling only: `scripts/repair-reddit-images-roux.ts` (dry run by default, guarded image-only writes, never fetches), its planner regression test, and `docs/reddit-roux-image-pull.md`. No `src/` change, so production stays at the Worker built from `a0df03e`; no deploy was needed or run. The **live data repair was already applied before the merge** (23 Reddit image repairs + 22 terminal marks, documented in `docs/reddit-roux-image-pull.md`); the merged script is the reusable record of that run and must not be re-run against production. Integration review found no drift (`src/reddit.ts`, `src/reddit-repair.ts`, migration `0014` unchanged since the PR base). Validation on the integrated revision: `npm ci` (0 vulnerabilities), `npm test` (41 files, 487 tests), `npm run typecheck`, `npm run build` (dry run).
- **#16 reviewed, not merged** (head `2971c69`, review-only per the user's instruction). Merges cleanly into current main; full suite green on the integration (41 files, 490 tests), so no false positives against the saved fixture corpus. The new `assertArticleFeed` guard is **necessary for the sitemap.rss shape**: probed without the guard, `parseFeed` accepts the RSS-shaped sitemap robots.txt advertises and returns a bogus "article" titled with the `post-sitemap.xml` URL, which the existing empty-parse check would not stop (length 1). HTML challenge pages and sitemap indexes were already caught by `parseFeed`'s `Invalid feed` throw; for those the guard is clearer-error defense-in-depth. `feeds.nimb` stays `[]` (NIMB paused, manual imports stay, read-only D1 evidence only). Recommendation: **merge in a later integration slot that ends in a deploy** — it is Worker code (`src/ingest.ts`) and only takes effect once deployed; no urgency while NIMB is paused.
- **#19 stays on hold** per the user's decision (slug-derived NIMB headlines); untouched in this review.

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
6. **Satire quality audit follow-up (2026-11-20, recorded, not patched):** a read-only production audit of the 88 stored takes found a repetitive punchline pattern — about 14 takes the user's audit flagged, and a read-only recount corroborates 20 of 88 using a "because…/porque…" punchline, several of them music/choir puns ("harmonize", "chorus", "choirs", "what's a mall without a little music"). Fixing this well needs a reviewed prompt/validity change plus regeneration policy, not a broad filter patch, so it is parked here for the operator's decision. Nothing was deleted or rewritten.
7. **Sensitive-stem gaps in Spanish (2026-11-20, recorded, not patched):** the satire eligibility guard (`sensitive()` in `src/lighter.ts`) misses Spanish stems such as `agred` (agredió/agresión), `atac` (atacó/ataque), and `acus` (acusó/acusación), so a story whose headline/excerpt only uses those words could still get a satire button. Any widening of the sensitive list also hides more stored takes and belongs in a reviewed change with a read-only production recount first; no unreviewed broad filter patch was applied.
