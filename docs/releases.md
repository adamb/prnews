# Releases

## 2026-11-17 — About credits and translations

- Deployed source: d1c17e3bd55e4ce911e512ae3eae66f0df47dd67.
- Cloudflare Worker version: 1e87d40c-0cb8-413d-a266-c2da7a8cc68f.
- Preserved reviewed dependency ea643ba5679bc585dc89f02f6ebf72019822d9e8.
- Coordinated fast-forward integration into unchanged main; feature branch and remote main SHA verified before manual Wrangler deployment.
- Validation: npm ci (zero vulnerabilities), 259 tests passed, typecheck, build and diff check; tests/typecheck/build repeated on the integrated revision.
- Public Spanish and English About pages fetched successfully with curl; verified development-tool and runtime-model link targets, 300-character statement, cached reuse and bounded retry copy. Python urllib was denied HTTP 403; curl succeeded.
- Copy-only release; no migrations. Original publisher links and excerpt limits preserved.
