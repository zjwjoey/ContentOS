# ContentOS Job / Workflow Decision

## Definition

A Job is the durable, idempotently claimable record of one long-running ContentOS operation. The queue is a delivery/claim mechanism, never the system of record. A Workflow is a versioned orchestration definition; V1 uses a small number of fixed workflow services, not a user-authored DAG editor.

## State machine

```text
CREATED -> QUEUED -> RUNNING -> SUCCEEDED
                     |          
                     +-> RETRY_WAIT -> QUEUED
                     +-> FAILED
                     +-> BLOCKED
CREATED|QUEUED|RETRY_WAIT -> CANCELLED
RUNNING -> CANCELLING -> CANCELLED | FAILED | TIMEOUT
```

`FAILED` means terminal after policy exhaustion; `BLOCKED` means human/actionable precondition (login, missing asset, approval) and is not an error retry target. `TIMEOUT` is a terminal attempt outcome that may transition to `RETRY_WAIT` by policy. Avoid duplicate status aliases such as `completed/done/success`.

## Dependencies

V1 stores `JobDependency(job_id, depends_on_job_id, required_status=SUCCEEDED)`. A dispatcher only queues a job when every dependency is succeeded. If a dependency becomes terminal failed/cancelled/blocked, mark the dependent `BLOCKED` with the causal Job ID. No DAG scheduler, graph UI or arbitrary conditional edges in V1.

## Reliability requirements

- Claim through an atomic lease; worker heartbeat extends lease; reaper returns expired claims to queue after recording abandoned attempt.
- Idempotency key is unique per `(project_id, job_type, input_revision)`; retries reuse it and new explicit user actions create a revision.
- Persist progress as bounded events plus current percentage/phase; never make a WebSocket stream authoritative.
- Cancellation is cooperative: set `cancel_requested_at`, worker polls it and terminates FFmpeg/browser children before final transition.
- Retry policy belongs to `JobType`/adapter, not a broad `catch Exception -> retry` rule. Validation, auth and schema errors are non-retryable.

## Queue candidates

1. **pg-boss + PostgreSQL — first candidate for Node/TypeScript modular monolith.** One operational database, durable jobs, retries and queues; simplest Windows local deployment. Verify required features with a small future spike before commitment.
2. **BullMQ + Redis — second candidate.** Strong worker/progress/ecosystem fit, demonstrated by n8n’s Bull scaling architecture; adds Redis and two durability systems but is justified if throughput/concurrency needs rise early.

Celery/Dramatiq/Arq are valid only if the actual backend becomes Python. Temporal is deliberately excluded from V1: excellent durable workflows but too much operational and conceptual surface for the fixed pipeline.

## Worker decision

API/Core, Video Worker and Publisher Worker run as separate processes. Separate processes contain FFmpeg memory/CPU faults and Chromium crashes, permit different concurrency, and allow backend restarts without killing active media/browser work. They communicate only via database state, asset storage and the queue—never direct module calls or Electron IPC.
