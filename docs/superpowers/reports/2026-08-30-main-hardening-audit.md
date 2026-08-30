# Main Hardening V1 Baseline and Repair Audit

Date: 2026-08-30  
Branch: `codex/main-hardening-v1`  
Base: `9a6886e` (`main` after PR #4 merge)

## Baseline evidence

- `pnpm install --frozen-lockfile` completed successfully in the isolated worktree.
- `pnpm test` discovered 220 baseline tests; 117 passed and 103 failed before product assertions because the expected PostgreSQL endpoint `127.0.0.1:55432` was unavailable. One FFmpeg test also used a legacy binary without `libx264`.
- `pnpm audit --prod --audit-level high` initially reported 1 critical and 12 high vulnerabilities, including Next.js `<14.2.25` middleware bypass. After the upgrade and overrides, the same gate exits successfully with one moderate advisory and no high/critical findings.
- Baseline had no `.github/workflows`, a manually enumerated `test` script, and a `lint` script that was actually a secret scanner.

## Implemented repairs

1. Upgraded Web to Next `15.5.21`, React/ReactDOM `19.1.1`, and patched transitive `postcss`/`sharp` versions. Migrated dynamic project pages to Promise params with React `use()`.
2. Added `CONTENTOS_API_HOST` and `CONTENTOS_WEB_HOST`, both defaulting to `127.0.0.1`; API and operator Web launches bind explicitly to loopback.
3. Restricted new Approval decisions to `RENDER` and `PUBLISH`; Director Script/Storyboard acceptance remains in Director. Added PostgreSQL transaction advisory locking for Approval revision allocation.
4. Added `safeProfileKey`, registered platform allow-listing, and root-contained LocalStorage object paths.
5. Replaced comparator-based seeded shuffle with deterministic Fisher–Yates and added a regression guard.
6. Project Center now ignores legacy Director Approval rows and exposes real Video/Approval stage links.
7. Added real ESLint/Prettier checks, recursive test discovery (`90` files at baseline), `test:inventory`, `security:scan`, and `.github/workflows/ci.yml`.

## Outstanding / blocked

- Database-backed gates cannot be freshly verified until a PostgreSQL test database is reachable with the repository's configured credentials/URL.
- Local browser acceptance likewise depends on the same database and a FFmpeg build with `libx264`/AAC.
- GitHub branch-protection mutation requires repository administration permission and is intentionally not performed locally.
- No hardening PR has been merged; human review remains required.
