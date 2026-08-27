# ContentOS Architecture Guardrails

> These rules protect stable boundaries. Breaking one requires an ADR/ECR and explicit review.

## Sources of truth

PostgreSQL is the durable source of truth for Projects, Jobs, attempts, revision pointers, approvals, Publisher state and AI provenance. Queue delivery state and process memory are not authoritative.

The filesystem may hold staging media, promoted content-addressed blobs, browser profiles and temporary render output. Required database state must never be inferred only from filesystem state.

## Module ownership

```text
API / UI
  -> application services
      -> domain modules
          -> infrastructure ports/adapters
```

| Module | Owns |
|---|---|
| Project | identity, existence and project metadata |
| Asset | staging, hashing, promotion, deduplication and project links |
| Job | state machine, idempotency, attempts, retries, cancellation, leases and recovery |
| Director | brief, Script/Storyboard revisions and creative transitions |
| Video | Video Jobs, plans, manifests, render orchestration and render metadata |
| Publisher | publish snapshots, account/platform state, adapters, outcomes and reconciliation |
| Approval | immutable approval/rejection decisions and target binding |
| AI | provider abstraction, prompt registry, normalized results and run provenance |

Application services use published contracts. Do not cross-read or cross-write another module’s private tables when an owning service exists.

## Immutability and provenance

Historical Director revisions, approval decisions, AI runs, publish snapshots and versioned manifests are append-only unless their contract explicitly defines a safe state transition. Every derived artifact and asynchronous event carries relevant project, job, attempt and correlation identifiers.

Every persisted AI result records provider, model profile, prompt version, request type, source project/revision, run ID and outcome. Generated text without provenance is incomplete.

## Video invariants

`EDIT_MANIFEST_V0` is an execution contract. Renderer code may validate, execute, fail and report diagnostics. It must not rewrite narration, select a new creative angle, invent a storyboard, alter approved meaning or silently replace missing media with unapproved content.

## Job invariants

Long-running or externally dependent work is a durable Job with a stable ID, type, project traceability, explicit state, attempt history, idempotency key where required, structured errors, bounded retries, cancellation semantics and crash recovery. Lease recovery, current-attempt fencing and external reconciliation are required paths.

Success/failure/cancellation may only finalize the current active attempt. A late or recovered attempt must not overwrite a newer attempt or create an unreferenced successful business record.

## Publisher safety

Publisher requires an explicit account, platform, immutable or hash-bound content snapshot, exact approval binding, credential isolation, normalized outcomes and reconciliation. Never publish mutable unapproved content, log credentials, switch accounts silently, bypass verification, or blindly retry an unknown outcome.

## Credential boundary

Tokens, refresh tokens, cookies, browser session state, passwords, API keys and authorization headers stay out of source control, domain snapshots, Job payloads, normal logs and test fixtures. Providers are injected and held in memory only as long as needed.

## Migration and architecture change

Migrations are ordered and append-only after sharing. Each migration has a safe down companion where feasible and is verified on an isolated database. If a task requires a boundary/invariant change: stop, document the reason and alternatives, add an ADR/ECR, obtain review and only then implement.

