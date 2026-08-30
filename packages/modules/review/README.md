# Review module

Review is reserved for post-publish MetricSnapshot, performance observations, AI review and recommendations. Pre-publish decisions belong to the Approval module (`packages/modules/approval`) and its `APPROVAL_V0` contract.

Review Analytics V1 now records immutable `MetricSnapshotV1` rows for confirmed Publisher `ExternalPost` records and creates provenance-backed AI analysis reports through durable Jobs. Collection is limited to the deterministic Fake source and operator-provided Import source; real platform metrics are intentionally disabled.

The module consumes Publisher only through its project-scoped `PublisherExternalPostReader` port. `REVIEW_COLLECT_METRICS` and `REVIEW_GENERATE_ANALYSIS` are handled by `workers/review-worker`; HTTP handlers only validate input and enqueue work.
