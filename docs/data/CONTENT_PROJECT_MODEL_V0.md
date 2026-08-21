# Content Project Model V0

`ContentProject` is the durable root for one planned content item, not a mirror of worker runtime state.

```text
ContentProject
 ├─ ContentPlan (one current, revisions retained)
 ├─ ScriptRevision / StoryboardRevision
 ├─ AssetLink -> Asset
 ├─ EditManifest -> Render -> Asset(rendered file)
 ├─ PublishRequest -> PublishAttempt -> MetricSnapshot
 ├─ Review
 └─ Job (by project_id)
```

## Lifecycle

Project status communicates **business readiness**, not job execution. V0 values: `DRAFT`, `IN_PRODUCTION`, `READY_TO_PUBLISH`, `PUBLISHED`, `REVIEWED`, `ARCHIVED`.

- Job status represents operation execution (`QUEUED/RUNNING/...`).
- Render status represents an individual Render’s output validity (`PLANNED/RENDERING/READY/FAILED/SUPERSEDED`).
- Publish status represents an individual account-platform attempt (`SCHEDULED/PUBLISHING/PUBLISHED/FAILED/BLOCKED`).

The Project status is derived by an explicit Project lifecycle use case from durable child facts, not copied blindly from every child event.

## Versioning and deletion

Scripts, storyboards, plans and manifests are append-only revisions; current pointers are mutable. Archiving removes the Project from ordinary work queues but preserves audit/history. Deletion is a controlled retention workflow: block new Jobs, retain or delete assets by policy, and never cascade-delete historical PublishAttempt/AI provenance unintentionally.
