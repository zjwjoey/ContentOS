# ContentOS Main Hardening V1 Final Report (working branch)

## Baseline

- Base: `9a6886e` / PR #4 merge baseline (verified against the isolated worktree).
- Branch: `codex/main-hardening-v1`.
- Node `v24.14.0`, pnpm `10.32.1`.
- Baseline discovered 220 tests: 117 passed, 103 failed because the configured PostgreSQL test endpoint `127.0.0.1:55432` was unavailable; one legacy FFmpeg binary lacked `libx264`.
- Production audit baseline: 33 vulnerabilities including one critical; no CI workflow or automatic test discovery existed.

## Implemented repairs

- Next 15.5.21 / React 19.1.1 upgrade, localhost defaults and Next 15 dynamic params migration.
- Formal Approval boundary, pending-only API contract, transaction advisory-lock revision allocation and locked transition re-read.
- Project Center stage links and Director-derived readiness; Assets stage remains visible.
- Storyboard Planner V1 contract, manual scene bindings, exact scene durations, scene provenance and deterministic selection.
- Publisher profile allow-list/path containment and LocalStorage object containment.
- Real ESLint, Prettier, recursive test discovery/inventory and renamed `security:scan`.
- GitHub Actions jobs: `quality`, `tests`, `web-build`, `browser-acceptance`.
- Doctor now checks actual storage write, PostgreSQL reachability and migration state.
- Project Center stage contract is now `ASSETS → DIRECTOR → VIDEO → APPROVAL → PUBLISHER`; all stages have real routes.
- README, design, plan, findings and progress records updated.

## Fresh local evidence

- Focused approval/planner/path tests: pass.
- Unit + contract suite after repairs: 114/114 pass (with the available local FFmpeg paths).
- Fresh unit + contract suite after the final Planner/Assets/Approval changes: 117/117 pass (with the available local FFmpeg paths).
- Root build, Web build, typecheck, ESLint, Prettier, security scan and `git diff --check`: pass.
- `pnpm audit --prod --audit-level high`: exit 0; one moderate advisory remains.
- `pnpm test:inventory`: 90 ordinary test files discovered.
- Fresh automatic full-suite discovery: 282 tests discovered; 161 passed and 121 were blocked by unavailable PostgreSQL at `127.0.0.1:55432` (plus dependent browser/integration cases).

## Outstanding gates

- Full migration/integration/browser gates are not locally green until PostgreSQL is reachable at the configured test URL and FFmpeg includes `libx264`.
- GitHub `main` branch protection could not be queried because `gh` is not installed/authenticated in this environment; no settings mutation was attempted.
- The branch is intentionally uncommitted until the final database/browser gate and human review are available.

## Verdict

`CONTENTOS MAIN HARDENING V1 NOT READY FOR MAIN` while the environment-dependent gates above remain unresolved. No merge is performed in this branch.

## Post-repair verification (2026-08-30)

- Added and passed a legacy-data migration regression: `RENDER` project assets migrate as workspace `OUTPUT`; unsupported legacy roles are excluded from the video-only link table.
- Migration matrix: **5/5**.
- Full automatic suite: **286 discovered, 284 passed, 2 expected browser skips, 0 failed** with PostgreSQL on 5432 and FFmpeg 8.1.2 (`libx264`).
- Final quality gates: `format:check`, ESLint, `security:scan`, typecheck, root build and `pnpm audit --prod --audit-level low` all pass.
- This updates the local engineering evidence; the branch is still uncommitted and no merge/push was performed.

## Updated verdict

`CONTENTOS MAIN HARDENING V1 LOCALLY VERIFIED` for the available test environment. GitHub branch-protection verification and manual browser visual acceptance remain external gates; no merge is performed in this branch.
