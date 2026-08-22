# Publisher module

Slice 4 provides a platform-neutral `PublisherAdapter`, a deterministic Fake Platform,
isolated per-account profile directories and normalized failure taxonomy. The module does
not store real credentials or call real platforms. Douyin/WeChat adapters remain deferred
to Slice 5 pending explicit credential, human-confirmation and smoke-test gates.

The foundation slice now owns the PostgreSQL records for `PublisherAccount`,
`PublisherRequest`, immutable `PublisherRequestRevision`, `PublisherAttempt` and
`PublisherExternalPost`. `PublisherService` is the only service that mutates those
records. The request status transition guard rejects invalid lifecycle changes and
`UNKNOWN_EXTERNAL_STATE` remains a reconciliation-only condition.
