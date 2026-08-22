# Review Module V0 — Post-publish Performance

## Boundary

Review owns post-publish metric snapshots, observations, performance analysis, AI review and recommendations. It does not approve scripts, renders or publish requests; those transitions use the separate Approval Gate contract.

## Review types

| Type | Subject | Example outcome |
|---|---|---|
| Metric review | external post / MetricSnapshot | explain performance |
| Strategy review | project history and snapshots | recommendation for later Director work |

Performance review records reference a confirmed external post, metric snapshot IDs, policy/model version, evidence references, reviewer or AI run, timestamp, outcome and rationale. Records are append-only and never change published metadata silently.

## Metrics

Metrics are imported as timestamped `MetricSnapshot`s with source adapter, collection window, raw normalized values and collection reliability status. They are historical observations—not live mutable counters—and must never be used to silently change published metadata.

## Dependencies

Review reads snapshot contracts from Director, Video, Publisher and Asset. It may request metric collection through a narrow Publisher contract. It must not own browser automation, job leases, AI provider credentials or project lifecycle state.
