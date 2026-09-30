# Desktop / Intelligent Editing Migration Integration Notes

## Current inventory

The Desktop ancestry currently contains:

- `migrations/0047_digital_human_duration.sql`
- `migrations/0047_digital_human_duration.down.sql`

The Intelligent Editing line is recorded as containing:

- `migrations/0047_intelligent_editing_v15.sql`
- `migrations/0047_intelligent_editing_v15.down.sql`

This is a migration-number collision. It is not resolved in the Desktop closure branch.

## Required integration procedure

At integration time, from a freshly fetched `main`:

1. Enumerate every `migrations/*.sql` and `*.down.sql` pair from `main`, Desktop, and Intelligent Editing.
2. Compare migration names, forward SQL, down SQL, and the migration runner's ordering rules.
3. Choose the next unused migration number in the integration branch.
4. Rename only the colliding feature migration pair(s) in the integration branch and preserve their SQL semantics.
5. Update any fixtures, migration expectations, documentation, or seed references that use the old filename.
6. Run the fresh-database migration matrix and an upgrade-from-main matrix.
7. Verify the down migration ordering and repeat the matrix with both feature sets enabled.

## Constraint for this closure

Do not modify `feature/contentos-intelligent-editing-v15`, do not silently renumber its files here, and do not merge `main` into the Desktop branch merely to make the collision disappear. This document is the handoff contract for the later integration reconciliation.
