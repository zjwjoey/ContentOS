# Review Module V0

## Boundary

Review owns validation gates, review tasks, metric snapshots, observations, recommendations and decision records. It answers whether a particular revision/output/request is eligible for the next business transition; it does not render or publish.

## Review types

| Type | Subject | Example outcome |
|---|---|---|
| Creative review | script/storyboard revision | approve, return-for-revision |
| Render review | Render/output Asset | pass technical validation, reject quality issue |
| Publish review | Publish request | approve schedule, block policy violation |
| Performance review | external post / MetricSnapshot | recommendation for later Director work |

A review decision records subject type/ID/revision, policy version, evidence references, reviewer (human or system), timestamp, outcome and rationale. Decisions are immutable; an override is a distinct decision with an authorized actor and reason.

## Metrics

Metrics are imported as timestamped `MetricSnapshot`s with source adapter, collection window, raw normalized values and collection reliability status. They are historical observations—not live mutable counters—and must never be used to silently change published metadata.

## Dependencies

Review reads snapshot contracts from Director, Video, Publisher and Asset. It may request metric collection through a narrow Publisher contract. It must not own browser automation, job leases, AI provider credentials or project lifecycle state.
