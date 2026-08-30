# ADR-014 — Review Analytics V1

## Decision

Review is post-publish analytics only. It reads confirmed Publisher ExternalPosts through a public project-scoped port, persists immutable MetricSnapshot V1 observations, and produces append-only AI analysis reports through durable Jobs and a dedicated Review Worker.

## Constraints

- Approval Gate remains the pre-publish decision boundary; Review does not approve or mutate Publisher state.
- HTTP routes enqueue `REVIEW_COLLECT_METRICS` and `REVIEW_GENERATE_ANALYSIS`; they never call metrics providers or AI synchronously.
- Fake and Import sources are the only enabled rollout. Real platform metrics require a later reviewed adapter change.
- PostgreSQL is business truth; Job rows are delivery state and include idempotency, lease, cancellation and fencing behavior.
- AI calls use `AIService` and persist prompt/model/provider provenance in `ai_runs`.
