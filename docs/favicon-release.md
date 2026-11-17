# Favicon monogram release — November 17, 2026

Deployed source: `73dc9f90add5ef88c73e69b20043f22dd958d107` — merge of favicon branch `t3/favicon-monogram` `5131ed621bcf5c6c1c81d0640501cd43c3154998` onto main `9d5ec0e609da13d6b63bfff1d69c4be7e81c8914` (lighter release notes tip).

Worker version: `4b20ef08-d910-4e16-b585-ba86fd63e794`, succeeding the lighter release `cd9b9bfa-5720-463b-9fa2-629928d30e79`. Coordinated exclusive release slot; remote main fast-forwarded `9d5ec0e..73dc9f9` and the verified SHA was read back from GitHub before Wrangler OAuth deploy. No migrations (favicon adds schema-less constants only; the deployed database stays at `0011_lighter.sql`).

## Integration

The combined diff versus main is exactly the favicon feature: new `src/favicon.ts` (original vector-code "PR" monogram, same site green `#166149` badge and cream letterforms), routes wired before the renderer in `src/index.ts` so icons work with or without D1, and favicon `<head>` links on the renderer and the alerts shell. `src/lighter.ts` (structured lighter parser with hardened decoder) and `src/alerts.ts` (alert edition/locale fixes) are unchanged by the merge — verified byte-identical against main before push. Reviewed diff contains no binary files in Git (ICO/PNG are base64 in code) and no secrets, tokens, emails, or endpoints.

Validation at the release commit: npm ci; npm test 278 tests in 26 files (277 on the standalone favicon branch, 273 on main, 278 combined); TypeScript check; Wrangler dry-run build.

## Public verification (GET/HEAD only)

Production `news.dev.pr`, all `GET`/`HEAD`:

- `/favicon.ico`: GET 200 `image/x-icon`, 15,086 bytes, valid Windows ICO with 16/32/48 px 32-bpp frames; HEAD 200, fixed `image/x-icon`, `cache-control: public, max-age=86400`, `x-content-type-options: nosniff`.
- `/favicon.svg`: GET 200 `image/svg+xml`, 351 bytes (monogram source of truth); HEAD 200 same fixed headers.
- `/apple-touch-icon.png`: GET 200 `image/png`, 2,577 bytes, valid opaque 180×180 PNG; HEAD 200.
- Spanish and English home and `/alerts` pages each ship the three `<link rel="icon">` / `<link rel="apple-touch-icon">` head tags.
- Alerts privacy headers unchanged: `content-security-policy` (plain CSP with Turnstile on form pages), `cache-control: no-store`, `referrer-policy: no-referrer`, `x-robots-tag: noindex, nofollow`. Home headers unchanged. The bodyless alerts `HEAD` fast-path (no `content-type`/CSP response on HEAD) predates this release (`a0b7c82`) and is untouched.

No accounts signed in, no alert sessions opened, no emails sent, no `/click` fetches, and no `/internal/*` endpoints called. The workers.dev URL returned 200 for `/favicon.ico` during rollout.

## Rollout note (honest record)

`wrangler deploy` reported the new version at 100% immediately, but for roughly the first 1–3 minutes requests from this location still reached the previous version or stale cached copies: `/favicon.ico` and `apple-touch-icon.png` first returned the renderer's 404 and the home HTML omitted the link tags. Re-checks a few minutes later showed the identical version 100% active and all icon routes/pages correct without any further action; headers sampled at 13:34–13:41 UTC / 09:34–09:41 AST in MIA. This is deployment propagation lag, not a code defect; it resolved on its own and the final checks above all pass at the recorded Worker version.
