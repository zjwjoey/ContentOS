# ADR-015: Project-scoped Video Inputs and Current Render Selection

## Status

Accepted for the Project Center and Video V0 repair slice.

## Decision

Video planning reads READY source assets through the Asset Catalog public contract, always supplying the project association and source kind (`VIDEO` or `AUDIO`). The catalog requires a `project_assets` SOURCE link; Video does not resolve source assets by ID alone. A missing catalog dependency fails closed before a Manifest or Render is persisted.

The Director-to-Video bridge derives its Job idempotency key from the approved Director target and a stable fingerprint of all render-affecting inputs: ordered source asset IDs, duration, seed, voice asset and subtitle text. Repeating the same input returns the same Job; changing a render input creates a distinct Job.

Project Center considers a Render current only when its successful output belongs to a `PERSISTED` Edit Manifest for the same project. Superseded manifests remain historical and cannot supply a current Render approval target.

Manifest replacement is serialized per project inside one database transaction with a transaction-scoped advisory lock. Superseding prior manifests, allocating the next revision, persisting the Manifest, and creating its Render therefore form one atomic state transition. The durable Job's `projectId` is the authority for every catalog lookup and persisted record. A recovered delivery for the same Job reuses its already-persisted Manifest and Render instead of creating a second pair; when that Render already succeeded, the Worker returns its recorded output without running FFmpeg again.

The successful-Render lookup happens before source Catalog validation, because completed output remains authoritative even if historical source associations are later archived or temporarily unavailable. An unfinished Render records the active Job `attemptId` and attempt number. Video's public Render transitions require a branded, live Job attempt scope; raw attempt identifiers are not accepted. A newer attempt may fence an older one, and an expired caller cannot directly invoke a public Video transition outside an active Job transaction.

Render start, Asset catalog commit, Render completion and Job completion are orchestrated through published contracts using the same PostgreSQL transaction scope. File hashing, probe, staging and content-addressed promotion happen before that short transaction. Asset returns an internally branded prepared capability bound to the producing storage provider; consumers cannot construct it, and commit also verifies the promoted blob still exists. Only that verified immutable handle enters the transaction. Asset, Video and Job each issue only their own table mutations. A failed completion rolls back the READY Asset row, Render transition and Job transition together, so Publisher cannot discover a loser output. The promoted blob may remain an orphan and is covered by Asset reconciliation. Cancellation similarly commits Render, JobAttempt and Job as `CANCELLED` together, including lease recovery through Video's cancellation callback. No module reads or writes another module's private tables.

Each FFmpeg attempt writes to its own temporary output path before Asset-owned content-addressed promotion. `AbortSignal` propagates from Job heartbeat through the Video Worker into the FFmpeg subprocess; the renderer waits for the child's `close` event before rejecting and cleaning partial output. The active handler removes its attempt-local file on success, failure, cancellation or stale completion. Crashed-worker cancellation recovery removes the exact `<jobId>-<attemptId>.mp4` output and matching `.part.mp4` files using validated literal paths. Overlapping lease recovery therefore cannot make two processes write the same file or retain cancelled attempt output.

## Evidence

- `tests/integration/video-project-read.test.ts` rejects a foreign source asset and ignores a successful Render attached to a superseded Manifest.
- `tests/integration/video-project-read.test.ts` also proves successful replay without source association and rejects stale Render completion/failure, including the lease-expiry window before a replacement attempt starts.
- `tests/integration/job.test.ts` proves lease heartbeat, four-way pool-safe transaction scopes, atomic rollback, durable cancellation and stale Job-attempt fencing.
- `tests/integration/video-project-read.test.ts` proves crashed-worker cancellation reconciliation closes the Render and that rejected finalization leaves no READY output Asset.
- `tests/e2e/video-vertical-slice.test.ts` executes the composed Video Worker entry, which runs lease cancellation reconciliation before consuming a delivery.
- `tests/unit/video-renderer.test.ts` proves both pre-start and active FFmpeg abort clean partial output; the Video E2E proves attempt-local output cleanup after Asset promotion.
- `tests/integration/director-video-v1.test.ts` verifies that changing source inputs changes the Job idempotency identity.
- `tests/unit/project-center.test.ts` and `tests/integration/project-center-api.test.ts` verify exact current Render approval filtering.

## Consequences

- Cross-project source asset references fail closed at the Video boundary.
- Render retries remain idempotent without collapsing materially different compositions into one Job.
- Historical Render and Approval records remain queryable without affecting current Project Center health or actions.
