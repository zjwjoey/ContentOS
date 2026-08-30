# Architecture Invariants

These rules are non-negotiable unless changed by a superseding ADR.

1. Core coordinates work; workers execute external or resource-heavy work.
2. PostgreSQL preserves business facts and Job state; a queue is not the sole source of truth.
3. Module ownership is exclusive; cross-module writes use application contracts.
4. Project, Render, Publish and Job state machines are independent.
5. Creative revisions, manifests, attempts and review decisions are append-only.
6. `EDIT_MANIFEST_V0` is immutable, explicit and renderer-declared compatible.
7. A renderer never makes creative decisions or publishes output.
8. A Publisher Worker never makes content decisions or uses raw credentials from the database.
9. All asynchronous side effects are idempotent and have a reconciliation path.
10. Cancellation is cooperative and represented as a durable state transition.
11. Canonical Assets are immutable and are promoted only after validation/checksum recording.
12. Temporary worker files are not canonical Assets and are subject to retention cleanup.
13. Provider and platform integrations are ports/adapters; domain code does not import SDKs.
14. AI output is untrusted until schema/policy validation and Director acceptance.
15. Credentials are opaque references; passwords, cookies, authorization headers, API keys, access/refresh tokens and browser session secrets never enter logs, Job payloads or normal business records.
16. API controllers are thin, versioned and do not run workers.
17. External publishing uncertainty is explicit; the system must reconcile before retrying a possibly successful post.
18. Observability metadata is propagated across API, Job, worker and external adapter boundaries.
19. V1 workflow is fixed: Director, Video, Approval Gate, Publisher, then post-publish Review; no generic workflow engine.
20. Approval decisions bind an exact target revision; Review owns post-publish metrics and recommendations only.
20. New dependencies that violate these invariants require an ADR before introduction.
