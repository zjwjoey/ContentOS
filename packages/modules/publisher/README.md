# Publisher module

The module provides a platform-neutral `PublisherAdapter`, a deterministic Fake Platform,
isolated per-account profile directories and normalized failure taxonomy. Credentials are
resolved through server-managed references and never persisted in ordinary records or logs.
Douyin Open API and WeChat Channels Playwright adapters are implemented behind an explicit
feature flag; account validation, human confirmation and smoke-test gates are required before
any irreversible real-platform submission.

The foundation slice now owns the PostgreSQL records for `PublisherAccount`,
`PublisherRequest`, immutable `PublisherRequestRevision`, `PublisherAttempt` and
`PublisherExternalPost`. `PublisherService` is the only service that mutates those
records. The request status transition guard rejects invalid lifecycle changes and
`UNKNOWN_EXTERNAL_STATE` remains a reconciliation-only condition.
