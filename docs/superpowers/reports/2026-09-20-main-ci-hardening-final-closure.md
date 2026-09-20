# Main CI Hardening V2 — Final Merge Closure

Date: 2026-09-20

## Scope

This closure migrates the CI hardening work onto a clean branch from the latest
`origin/main`. No Director, Publisher, Review, schema, Video, Planner, FFmpeg,
Presentation, or media product behavior was changed.

## Branch and migration

- Base: `origin/main` at `ca45b58085329f26d92552522161232d122b553c`.
- Final branch: `codex/main-ci-hardening-final`.
- Previous CI branch: `origin/codex/main-ci-hardening-v2` at
  `04fe1392606cc7f3a7c0b9597e2087638b0bef95`.
- Migrated CI-only commits: `33dbf6f`, `f775ce5`, `2de3eaa`, `ee1668d`,
  `769205b`, `6417acf`, `04fe139` (cherry-picked as `f200f38`, `7da38bd`,
  `eecf32b`, `10bc50e`, `1ab46b4`, `ce53ff9`, `df65567`).
- Skipped duplicate: `f5fc33a` (the equivalent Windows path fix is already in
  main as `8342962`).
- Safety closure commit: `f434d553834608b167b845348670eb98fb6cb4b4`.

The branch was pushed without modifying `main`. The only intentionally
untracked local item is the developer's `local-media/` directory.

## Database reset safety

`scripts/reset-test-database.ts` now fails closed. It accepts only
`CONTENTOS_TEST_ADMIN_DATABASE_URL`, requires `CONTENTOS_ALLOW_TEST_DB_RESET=1`,
allows only PostgreSQL URLs, enforces an exact expected database name containing
`test`, rejects unsafe names (`postgres`, templates, production/contentos
names), and refuses `NODE_ENV=production` before opening a connection. The pure
validator and unit tests cover missing URL, no fallback, explicit opt-in,
production refusal, protocol/name/mismatch rejection, and valid test databases.
CI sets the opt-in only on the two reset steps.

## Local gate results

- Format: pass (447 files).
- Lint: pass (164 TypeScript files).
- Typecheck: pass.
- Full test: **282/282 pass**.
- Migration matrix: **9/9 pass**.
- Auto Edit V1: **27/27 pass**.
- Auto Edit V1.5: **19/19 pass**.
- Script Editing V2: **34/34 pass**.
- Browser acceptance: **4/4 pass**.
- Root build and `apps/web` production build: pass.
- `pnpm doctor`: all checks pass with the existing global-bin PATH warning.
- `git diff --check`: pass.

## Remote verification

GitHub Actions run **#25** (`35491556914`) for branch
`codex/main-ci-hardening-final` completed successfully at head
`f434d553834608b167b845348670eb98fb6cb4b4`:

- Quality: success
- Database and tests: success
- Build: success
- Browser and render acceptance: success

The final branch is based directly on current `origin/main` (behind count 0);
the report-only commit that follows this implementation commit keeps the branch
ahead of main while preserving the same CI/product changes.

## Changed files

`.github/workflows/ci.yml`, `scripts/dev-operator.ts`,
`scripts/reset-test-database.ts`, `scripts/test-database-safety.ts`,
`scripts/test-operator-browser.ts`, the three browser acceptance tests, and
`tests/unit/test-database-safety.test.ts`.

## Conclusion

READY FOR MERGE
