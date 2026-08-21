# Database Model V0

PostgreSQL relational columns hold identity, ownership, lifecycle, timestamps and query-critical foreign keys. JSONB holds versioned structured payloads whose shape legitimately varies.

## Core tables

| Table | Owner | Key columns | JSONB |
|---|---|---|---|
| `content_projects` | Project | id, status, current_plan_id, archived_at | metadata |
| `content_plans` | Project | id, project_id, revision | plan payload |
| `scripts`, `storyboards` | Director | id, project_id, revision, status | content/scenes |
| `assets`, `asset_derivatives`, `project_assets` | Asset | id, kind, checksum, storage_key | technical metadata |
| `edit_manifests`, `renders` | Video | id, project_id, revision/status | manifest, render diagnostics |
| `accounts`, `publish_requests`, `publish_attempts` | Publisher | account/platform/status links | platform payload (sanitized) |
| `metric_snapshots`, `reviews` | Review | publish_attempt_id, captured_at | raw normalized metrics/review output |
| `jobs`, `job_dependencies`, `job_attempts`, `job_events` | Job | status, lease, retry, project_id | typed input/output/error details |
| `ai_providers`, `model_profiles`, `prompt_templates`, `prompt_versions`, `ai_runs` | AI | provider/profile/version links | safe configuration/request/response metadata |
| `outbox_events`, `audit_events` | Core | aggregate/type/timestamp | event payload |

## Constraints and indexes

- Foreign keys always retain Project traceability where applicable.
- Unique `(project_id, job_type, input_revision)` idempotency keys prevent duplicate intent.
- Unique `(template_id, version)` and immutable PromptVersion rows preserve provenance.
- Asset checksum plus storage key support deduplication/integrity without making filenames identifiers.
- Index active Jobs by `(status, retry_at, queue_name)` and PublishAttempts by `(account_id, status)`.

Secrets never live in JSONB request logs or worker payloads; encrypted credential material is isolated and referenced by ID.
