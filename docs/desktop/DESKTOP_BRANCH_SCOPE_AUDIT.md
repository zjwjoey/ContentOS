# Desktop V1 Branch Scope Audit

## Audit input

- Branch: `feature/contentos-desktop-v1`
- Closure base recorded at: `44f73363de250de648f999cbcebf40931e85c6cb`
- Comparison reference available locally: `origin/main` at `c8d0dd4`
- The current branch has no merge from `main`; no history rewrite is authorized for this closure.
- `git fetch origin` was attempted before the audit but failed because the configured proxy could not connect to GitHub. The comparison uses locally available refs only until a fresh fetch succeeds.

## Commit classification

### Desktop-only commits

- `a46ac6d feat: add ContentOS desktop runtime shell`
- `44f7336 docs: record desktop acceptance and remote handoff`
- The current uncommitted changes touching `apps/desktop/**`, packaging, desktop contracts, and Desktop-focused runtime wiring are treated as closure work in progress and must be split into reviewable commits.

### Runtime Startup commits required by Desktop

- `0d8fac8 feat: add unified runtime startup host and CLI`
- `648a31b test: harden runtime readiness and shutdown`
- `fc396a0 fix: harden runtime startup lifecycle`
- `48e920d fix: serialize runtime instance acquisition`
- `18e41fe fix: distinguish intentional runtime exits from crashes`
- `f8a2d23 fix: support packaged runtime host startup`
- `430652f fix: make stale runtime cleanup ownership-safe`
- `697d154 fix: serialize runtime background lifecycle tasks`
- `7595f80 fix: resolve packaged application root safely`
- `3c5bed6 test: assert runtime shutdown leaves no child processes`
- `be75327 docs: clarify packaged runtime layout`
- `aea974c fix: keep startup stop teardown single-owner`

These are not to be removed during Desktop cleanup. They provide the runtime-core, runtime-client, runtime-host, process ownership, state, and shutdown behavior on which the shell depends.

### Shared business commits in the ancestry

- `25f893e fix: complete operator ui localization`

This changes shared Web/operator UI rather than Desktop-only code. It should be reviewed separately at integration time and must not be used as evidence for distribution closure.

### Digital Human related commits in the ancestry

- `6f051e6 feat: add interactive digital human workbench`
- `d261143 feat: enforce digital human audio duration policy`
- `edf81d2 fix: close digital human duration validation`
- `96c5c67 fix: apply provider limits to requested duration`
- `a0de147 test: align fake avatar output with audio duration`
- `b1e308a test: keep fake avatar output out of media fixtures`
- `034172b feat: integrate HZAgent digital human generation`

These commits are not Desktop closure requirements. Optional Digital Human capability may remain in the runtime registry, but its business history and provider behavior require independent review.

## Files likely to conflict with Intelligent Editing

- `migrations/0047_*.sql` and corresponding down migrations: migration-number collision is confirmed.
- `packages/database/**`: migration loader/inventory and schema changes.
- `packages/contracts/**`: shared job/project/media contracts.
- `packages/modules/**`: shared service and provider boundaries.
- `apps/api/**`: shared API registration and environment wiring.
- `apps/web/**`: operator UI and runtime-facing pages.
- `packages/runtime-core/**` and `apps/runtime-host/**`: Desktop-required startup changes may overlap with feature runtime configuration.
- `package.json` and `pnpm-lock.yaml`: packaging dependencies/scripts can conflict with feature dependency changes.

## Recommended future integration strategy

1. Fetch `origin/main` and the Intelligent Editing branch immediately before merge review; do not rely on this audit's cached refs.
2. Build a complete migration inventory from `main`, Desktop, and Intelligent Editing.
3. Preserve migration semantics while renumbering the feature migration(s) in the integration branch only; never silently alter the other feature branch in this closure.
4. Cherry-pick or merge only the reviewed Desktop-only closure commits and the Runtime Startup commits proven necessary by the Desktop acceptance path.
5. Resolve shared contracts/API/Web changes with tests from both lines, then run the full migration matrix on a fresh database and an upgrade database.
6. Keep Digital Human and unrelated business commits explicit in the merge review; do not treat ancestry presence as a requirement to ship them in the Desktop package.

## Current conclusion

The branch is suitable for additive closure commits, but it is not yet merge-ready. The uncommitted distribution changes must be validated, packaged, and covered by clean Windows evidence before the branch can claim Desktop V1 acceptance.
