# ContentOS Branch and Integration Strategy

> Integration is a controlled convergence activity, not a conceptual merge.

## Current lines

The repository currently separates the stable `main` line from Director V1, Project Center, Publisher product/integration and real-platform adapter work. A capability is not integrated merely because another branch contains it.

Before integrating, record the exact branch, base commit, migration range, tests and live-verification status. Do not claim side-branch features in the main product context until the combined branch proves them.

## Target branch

Create or designate an integration branch from the latest `main` (for example `integration/contentos-v1`). Do not merge directly to `main` until the combined branch is green.

## Recommended order

```text
1. update from latest main
2. integrate Publisher project/product changes and migration 0006
3. integrate Director V1 and AI provenance changes (0007/0008)
4. integrate Project Center and its current migration/fence changes
5. reconcile contracts, APIs, Web routes, worker composition and migration numbering
6. run the combined full gate and integrated E2E
7. prepare a reviewed merge/PR to main
```

The order is a starting point, not permission to merge a dirty or unreviewed branch. If migration history differs, stop and produce a migration reconciliation note before resolving application conflicts.

## Conflict checklist

Inspect database numbering and down/up behavior; foreign keys and ownership; package scripts and dependency versions; exported contracts; approval target identity; Edit Manifest compatibility; API and Web route names; worker handler registration; environment examples; logging redaction; and project traceability.

No worker may shadow another handler. No required production capability may exist only on a side branch after integration.

## Required combined gate

```bash
pnpm run format
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
pnpm doctor
pnpm --dir apps/web build
```

Also run migration up/down checks and project-specific integration/E2E suites on the combined branch. Evidence must come from the merged code, not a collection of independent branch reports.

## Required combined E2E

```text
Project
 -> Brief
 -> Fake AI Script
 -> Script acceptance
 -> Storyboard approval
 -> Video Job and Render
 -> Render approval
 -> Publish snapshot and approval
 -> Fake Publisher
 -> durable final state
```

Real-platform smoke remains opt-in, account-specific and human-approved. It is never a prerequisite silently satisfied by using real credentials in normal tests.

## Main-branch criteria

Merge only when migrations are linear, all relevant tests and builds pass, no secret scan finding exists, no architecture deviation is unresolved, the combined E2E passes, docs/status reflect actual branch state and live verification is labeled accurately.
