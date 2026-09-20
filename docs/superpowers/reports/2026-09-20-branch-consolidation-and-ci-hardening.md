# ContentOS Branch Consolidation and CI Hardening

Date: 2026-09-20

## Phase A — Editing Presentation V1 Final Integrity Closure

- Starting `origin/main`: `42c9b2f1eb80fddf63bef67dd8932ec448cabcd9`
- Starting feature: `codex/script-editing-v2-rule-editorial-layer` at `4d8aca5916cc654fda5360517e925f8a93a5468c`
- Fix commit: `efa3b90` (`fix: preserve confirmed segments across presentation edits`)
- The Script V2 presentation-settings handler now invalidates only when segmentation rules change; font, position, canvas, resolution, fit, and subtitle edits preserve confirmed segments while invalidating stale plans.
- Browser regression coverage verifies preservation across presentation changes and explicit invalidation/reconfirmation for segmentation changes.

Feature and merge-rehearsal gates passed:

- format: 368 files
- lint: 150 TypeScript files
- typecheck, root build, and Web build: passed; Web build generated 15/15 routes
- full test suite: 282/282
- migrations: 9/9
- Auto Edit V1: 27/27
- Auto Edit V1.5: 19/19
- Script Editing V2 and FFmpeg: 34/34
- browser acceptance: 4/4
- doctor and `git diff --check`: passed (doctor only reports the existing pnpm global-bin PATH warning)

The feature was fast-forward merged through `codex/main-script-v2-merge-rehearsal` at `efa3b90`, then fast-forwarded into main. The CI hardening investigation also found and separately fixed host-independent Windows-path normalization in `apps/api/src/editing-workbench-routes.ts`; that follow-up is commit `8342962` on main. After this report commit, final `origin/main` is `c6ef372`.

**MERGED TO MAIN**

## Phase B — Main CI Hardening V2

- Base: latest merged main (`efa3b90`, with the compatibility follow-up `8342962` synced independently to main)
- Formal CI branch: `codex/main-ci-hardening-v2`
- Final CI branch commit: `04fe139` (`ci: build web with production runtime settings`)
- Workflow: `.github/workflows/ci.yml`
- Jobs: Quality; Database and tests; Browser and render acceptance; Build
- Postgres 16 service with `pg_isready` health checks and isolated schema resets between database suites
- Current Node 24 and pnpm 10.32.1; FFmpeg/FFprobe and DejaVu font installed on Ubuntu
- Playwright 1.62.1 Chromium; browser harness builds Web after the isolated API port is allocated, then runs production Web with the matching rewrite target
- Browser timeout/cleanup and failure diagnostics are enabled; logs upload on failure
- Fake Pexels/publisher providers only; no real external platform calls, credentials, Windows paths, or Windows fonts in CI

Remote GitHub Actions evidence:

- Run #24: [ContentOS CI run](https://github.com/zjwjoey/ContentOS/actions/runs/35490278389)
- Quality: success
- Database and tests: success
- Build: success
- Browser and render acceptance: success

**READY FOR REVIEW**

The CI branch remains intentionally unmerged. No remote branches were deleted.

## Historical Branch Cleanup Candidate List

No deletion was performed; this is classification only.

### A — Fully contained in current main

`codex/director-v1`, `codex/hybrid-media-script-editing-v1`, `codex/operator-ui-v1`, `codex/product-v1-repair`, `codex/project-center`, `codex/script-editing-v2-rule-editorial-layer`, `codex/unified-product-flow`, `codex/video-direction-correction`, `codex/video-quick-edit`, `feature/contentos-product-v1-closure`, `integration/contentos-v1`.

### B — Replaced by the latest main path

`codex/editing-workbench-v2`.

### C — Historical capability paths superseded elsewhere

`codex/review-analytics-v1`, `feature/slice-5-real-platform-adapters`.

### D — Reference only

`codex/main-hardening-v1`.

### E — Current formal CI work

`codex/main-ci-hardening-v2` (green, intentionally not merged).
