# Repository collaboration and releases

Read README.md before making changes. Follow existing TypeScript/Cloudflare patterns; preserve bilingual UI, dark mode, mobile layout, excerpt limits, and privacy protections.

## Git workflow

- Keep main as the integration branch. Start each independent coding task on a named feature branch in an isolated worktree created by the orchestration tool (not by a shell workaround). Use the current remote main as the independent base; explicitly use the dependent local commit when required.
- Assign ownership and dependencies before parallel work. Do not have multiple coders edit a shared checkout. This initial baseline is the exception that checkpoints earlier shared-directory work.
- Inspect status before editing. Preserve unrelated work; never reset, discard files, force-push, or rewrite shared history without explicit authorization.
- Make focused commits, review the diff, and record checks. Integrate through a reviewed PR or explicitly coordinated branch integration, resolving conflicts and retesting the combined result before release.
- Add factual commit trailers when AI contributed: `AI-Tool: Codex`, `AI-Model: <verified model>`, and `Validation: <checks>`. Record multiple tools/models only when supported by task records. If the model is unknown, say unknown; do not infer it from a Git author. Historical baseline attribution is incomplete and must not be fabricated.
- Never commit credentials, secret files, user emails/account exports, cookies, tokens, local D1/R2 state, generated build output, or node_modules. Public widget keys, analytics beacon identifiers and resource IDs are configuration, not credentials. Inspect the actual staged diff, not merely filenames.

## Validation and deployment

- Run `npm ci`, `npm test`, `npm run typecheck`, and `npm run build` for the integrated release. Tests/build regenerate ignored src/data.json from committed fixtures.
- Deploy only a tested, committed revision with no uncommitted source/config changes. Push the commit to the private remote first, verify its SHA, and record commit SHA plus Worker version in release notes. An isolated checkout is preferred. Never deploy in parallel with another release.
- Apply necessary additive D1 migrations with a reviewed migration plan; avoid replaying initial database creation or seed/import scripts on production. Wrangler OAuth or securely supplied environment credentials are supported; never print credential files.
- Production deployment is manual `npx wrangler deploy`; Git pushes do not currently trigger deployment. Git backs up code and migrations, not production D1 contents, R2 objects, Worker secrets, or email provider configuration.
