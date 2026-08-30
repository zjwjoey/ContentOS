# Metric Snapshot Contract V1

`MetricSnapshotV1` is an append-only, project-scoped observation of a confirmed Publisher `ExternalPost`.

- `schemaVersion`: `METRIC_SNAPSHOT_V1`
- `metrics`: non-negative safe integers for `plays`, `likes`, `comments`, `saves` and `shares`
- `source`: `FAKE` or `IMPORT`; real platform collection is not enabled
- `(externalPostId, source, capturedAt)` is idempotent in PostgreSQL
- `projectId` and `externalPostId` are required for traceability

`ReviewAnalysisReportV1` references one or more snapshots for the same ExternalPost and stores summary, highlights, risks, bounded `HIGH|MEDIUM|LOW` recommendations, and the originating `aiRunId`.
