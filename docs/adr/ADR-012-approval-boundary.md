# ADR-012: Separate Approval Gates from Post-publish Review

## Status

Accepted for the Publisher Fake product slice.

## Decision

ContentOS uses two distinct concepts:

- `Approval / Approval Gate`: a pre-transition decision over an exact Render or Publish target revision. The persisted contract is `APPROVAL_V0`; every formal Approval must bind `targetId` and `targetRevisionId`.
- Director Script and Storyboard editorial gates remain Director-owned revision transitions (`accept`/`approve`) and are not Approval rows. Historical `SCRIPT`/`STORYBOARD` rows remain readable only for compatibility and cannot be created by new API or service paths.
- `Review`: a post-publish performance capability. It owns `MetricSnapshot`, observations, AI review and recommendations. It does not approve a publish request and does not act as a render/publish gate.

Publisher queueing checks the Approval contract for the exact `PublishRevision`. It never checks a vague request-level approval and never treats an external post or metric observation as an approval.

Project-level aggregations apply the same exact-target rule to `RENDER` and `PUBLISH` decisions. Superseded decisions remain append-only history and do not affect current health or actions.

A cancelled Publish Request has no current Approval target. Its historical decisions remain auditable but never affect Project Center health, stage status, or actions.

## Compatibility boundary

The pre-freeze `review_decisions` table remains historical data, and `/reviews` remains a read-only compatibility surface for existing V0 clients and historical tests. Its write routes return `REVIEW_LEGACY_READ_ONLY`; no new feature may add writes to that path. New Publisher API, UI, Worker and documentation use `approval_decisions` and `/approvals`.

## Consequences

- Approval records can be audited against the exact revision sent to a platform.
- `Review` can evolve independently around platform metrics and AI recommendations.
- A later cleanup migration may retire the legacy table/routes after published clients are migrated; that is outside Slice 1.
