# Publisher Module V0

## Boundary

Publisher owns destinations, account references, platform capability profiles, publishing requests, schedules, attempts and confirmed external post references. It is the only module that creates `PUBLISH` jobs. It does not execute a browser; the Publisher Worker does. Pre-publish eligibility is owned by the separate Approval Gate contract; post-publish metrics are owned by Review.

The foundation persistence is private to Publisher: `publisher_accounts`, `publisher_requests`, `publisher_request_revisions`, `publisher_attempts` and `publisher_external_posts`. Other modules use public service contracts and never read these tables directly.

## Account and credential model

An `Account` is a logical destination identity and configuration record. It stores no raw secret. `CredentialRef` identifies a secret-vault record or local secure-store key and is resolved only inside the Publisher Worker. Account status is `UNVERIFIED`, `READY`, `REAUTH_REQUIRED`, `SUSPENDED` or `DISABLED`.

Platform adapters publish a capability profile: supported media types, title/description limits, scheduling support, authentication mode, required confirmation, metric availability and known constraints. A request is validated against the selected capability profile before it is queued.

## Commands and lifecycle

| Command | Result |
|---|---|
| `CreatePublishRequest` | immutable snapshot of output asset, metadata revision, account and desired schedule |
| `SchedulePublish` | schedule policy and `PUBLISH` Job, after an approved exact Publish Revision |
| `RecordPublishResult` | append-only Attempt and external post reference |
| `RequestReauthentication` | blocks new requests and marks account state |
| `CollectMetrics` | creates a Review-owned collection request/job dependency |

Publish requests move through `DRAFT -> SCHEDULED -> QUEUED -> PUBLISHING -> PUBLISHED | FAILED | CANCELLED`, with `RECONCILING` as the mandatory state after an uncertain external side effect. Attempts are separate historical records and request revisions are immutable. The worker receives `publishRequestId` and a snapshot revision, then revalidates account state, asset checksum and schedule window.

The `0009_publisher_foundation` migration protects enum values, revision numbering, request idempotency and external-post uniqueness. `PublisherService` locks the request aggregate before transitions, creates one stable request idempotency key, and requires a reconciliation result before another publish attempt after an unknown outcome.

## Browser automation constraints

Playwright is contained inside the Publisher Worker and behind a platform adapter. Adapters expose domain outcomes, not DOM selectors, to the module. The worker captures redacted diagnostics and permitted screenshots on failure; it never logs cookies, tokens, private URLs or credential values.

The adapter must use idempotent/deduplication checks where a platform supports them. If an outcome is uncertain after a crash, the request becomes `UNKNOWN_EXTERNAL_STATE` and reconciliation checks the platform before retrying. Blind reposting is prohibited.

Adapters normalize at least `AUTH_EXPIRED`, `REQUIRES_VERIFICATION`, `PLATFORM_CHANGED`, `RATE_LIMIT`, `UPLOAD_FAILED`, `NETWORK_ERROR`, `UNKNOWN_EXTERNAL_STATE` and `UNKNOWN`. Browser/profile isolation and secret redaction are worker invariants; the fake-platform Spike does not replace the gated provider sandbox smoke test.

## Dependencies

Publisher reads validated rendered Asset metadata through Asset and Project metadata snapshots through Project. It depends on Job for delivery, Approval for pre-publish gates and Review only through a metric-collection contract. It must not depend on Video implementation, FFmpeg, Director planning or AI provider SDKs.
