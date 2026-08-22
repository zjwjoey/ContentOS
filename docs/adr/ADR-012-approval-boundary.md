# ADR-012: Separate Approval Gates from Post-publish Review

## Status

Accepted for the Publisher Fake product slice.

## Decision

ContentOS uses two distinct concepts:

- `Approval / Approval Gate`: a pre-transition decision over an exact target revision. It covers creative, render and publish eligibility. The persisted contract is `APPROVAL_V0`; publish approval must bind `targetId` and `targetRevisionId`.
- `Review`: a post-publish performance capability. It owns `MetricSnapshot`, observations, AI review and recommendations. It does not approve a publish request and does not act as a render/publish gate.

Publisher queueing checks the Approval contract for the exact `PublishRevision`. It never checks a vague request-level approval and never treats an external post or metric observation as an approval.

## Compatibility boundary

The pre-freeze `review_decisions` table remains historical data, and `/reviews` remains a read-only compatibility surface for existing V0 clients and historical tests. Its write routes return `REVIEW_LEGACY_READ_ONLY`; no new feature may add writes to that path. New Publisher API, UI, Worker and documentation use `approval_decisions` and `/approvals`.

## Consequences

- Approval records can be audited against the exact revision sent to a platform.
- `Review` can evolve independently around platform metrics and AI recommendations.
- A later cleanup migration may retire the legacy table/routes after published clients are migrated; that is outside Slice 1.

