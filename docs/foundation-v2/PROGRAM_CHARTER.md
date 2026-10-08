# ContentOS Foundation V2 — Program Charter

Status: Phase0 initial baseline, 2026-10-08. This is a scoped engineering inventory, not a completed system audit.

## Objective and authority

Improve the engineering foundation while retaining the Desktop V1 + Intelligent Editing V1.5 integrated product. Start from `27d43854f0571d127bb1ed4ac01334ff294409b2`, which is 53 commits ahead of main `c8d0dd4725fac12feb5d9f0b5d9a04ac337fc0b6` with no commits behind at initial remote verification.

Work flows through `codex/fv2-phase0-baseline` → draft PR → `integration/contentos-foundation-v2`. Cloud development, commits, pushes, draft PRs, CI and tracking issues are authorized. No main writes or merges, force pushes, history deletion, destructive compatibility changes, new paid services or production releases. This delivery has one writer.

## Phase0 scope

Create these seven foundation documents, inspect branch-trigger coverage, minimally enable Foundation V2 target PR CI, retain all six existing jobs and verify checks against actual source. Preserve existing runtime contracts, migrations and product behavior. Distinguish historical evidence, source inspection, local execution and remote CI in every acceptance report.

## Constraints and exit

AGENTS.md is authoritative for module boundaries and architecture invariants. Boundary changes require evidence, an ADR update and architecture review. Phase0 exits only when the feature commit is remotely verified, a draft PR targets the Foundation integration branch, execution evidence is recorded and remote CI is read. Permission failures remain explicit blockers; local success is not remote completion.

See [acceptance](ACCEPTANCE_MATRIX.md), [progress](PROGRESS.md) and [roadmap](ROADMAP.md).
