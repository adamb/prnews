# Releases

## 2026-11-17 — About credits and translations

- Deployed source: d1c17e3bd55e4ce911e512ae3eae66f0df47dd67.
- Cloudflare Worker version: 1e87d40c-0cb8-413d-a266-c2da7a8cc68f.
- Preserved reviewed dependency ea643ba5679bc585dc89f02f6ebf72019822d9e8.
- Coordinated fast-forward integration into unchanged main; feature branch and remote main SHA verified before manual Wrangler deployment.
- Validation: npm ci (zero vulnerabilities), 259 tests passed, typecheck, build and diff check; tests/typecheck/build repeated on the integrated revision.
- Public Spanish and English About pages fetched successfully with curl; verified development-tool and runtime-model link targets, 300-character statement, cached reuse and bounded retry copy. Python urllib was denied HTTP 403; curl succeeded.
- Copy-only release; no migrations. Original publisher links and excerpt limits preserved.

## 2026-11-17 — Alerts navigation, copyright and About measurements

- Deployed source: ab4c8baed06f9d2851185375adae0913f81bfb03.
- Cloudflare Worker version: f3083fb6-4d4c-4985-a329-91054e25162b.
- Compact localized home navigation in the shared alerts shell; shared dynamic Puerto Rico-year copyright with publisher attribution in public and private footers.
- About reports 3,290 physical lines across 28 tracked application TypeScript files as of this date. README documents the reproducible scope/method. No complete development-token ledger exists in repository records; no estimates were inferred, and runtime translation usage remains distinct.
- Validation: npm ci (zero vulnerabilities), 262 tests, typecheck, build, reviewed diffs; tests/typecheck/build repeated after fast-forward integration. Remote main SHA verified before manual Wrangler deployment from clean committed source. No migrations.
- Public es/en alerts and home fetches verified navigation, locale and copyright; alerts retain no-store, no-referrer, CSP and no analytics/signup footer. About es/en measurements verified with a fresh release query key because an existing cached page initially retained older copy.
- Authenticated management/result/retry rendering verified with local fixtures and mocked mail only. No live sessions accessed or mail sent. Mobile sizing and keyboard focus implemented in CSS; no browser/390px visual inspection requested or performed.
- Earlier sequential deployments during additional user requests: c2a86f06f0966f4fb7cc84e57a8b70c0af55d565 / 5c2b704e-9499-4f66-b5e8-38c822dfb9ce; d0608abed1f53dfa987cc9daeeee8ce180d3aca2 / 43024b76-9404-4235-9537-eb5e0e3b0812.
