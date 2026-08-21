# JOB_MODEL_V0

```json
{
  "job_id": "job_01",
  "project_id": "cp_01",
  "job_type": "video_render",
  "status": "QUEUED",
  "phase": "awaiting_worker",
  "progress": 0,
  "input_revision": 3,
  "idempotency_key": "cp_01:video_render:3",
  "input": { "edit_manifest_id": "em_01" },
  "output": null,
  "attempt": 0,
  "max_attempts": 3,
  "lease": null,
  "retry_at": null,
  "cancel_requested_at": null,
  "created_at": "2026-08-21T00:00:00Z",
  "started_at": null,
  "finished_at": null,
  "error": null
}
```

## Required adjacent records

- `JobAttempt`: attempt number, worker identity, leased/started/finished timestamps, exit classification, sanitized error and bounded log/artifact references.
- `JobEvent`: timestamped phase/progress/status messages for UI streaming and audit.
- `JobDependency`: V1 gated dependency rows described in `job-system-decision.md`.

Input/output are versioned JSON envelopes validated by job type; they are not a dumping ground for secrets or unbounded logs. Credentials are referenced by opaque Account/Credential IDs.
