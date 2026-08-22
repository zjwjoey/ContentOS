# Publisher Safety Corrections Design

**Status:** Implemented and simulated verification complete; live platform smoke remains account-dependent.
**Scope:** Correct the real Publisher Worker safety, approval integrity, durable state and platform-result handling defects found on `feature/slice-5-real-platform-adapters`.

## Decisions

1. Browser profiles and screenshot artifacts are private local state. The repository ignores their default roots, adapter results return opaque evidence references rather than local paths, and documentation requires roots outside shared source directories in production.
2. Real publishing never uses process-memory idempotency. A Publisher-owned PostgreSQL state store records `PUBLISHED` or `UNKNOWN_EXTERNAL_STATE` by platform, account and idempotency key. An unknown state blocks reposting until an explicit reconciliation source confirms it.
3. A Publish review is bound to an immutable digest of platform, account, asset ID, asset SHA-256, title, description and optional cover checksum. The Worker recomputes that digest, verifies the local media checksum, and asks the Review module's public approval port to verify the latest approved decision and its stored digest.
4. The executable Publisher Worker fails closed without an explicit real composition root; it cannot silently run a no-op handler. The real composition root requires a durable state store.
5. Browser publish waits for a bounded success condition. Pre-submit browser failures normalize to retryable network failures; post-submit failures normalize to unknown external state. WeChat Channels returns no fabricated external post ID.
6. Douyin uses documented endpoint defaults (`/video/upload/`, `/video/create/`, `/video/list/`), preserves the endpoint profile override, detects MP4/WebM MIME type, and maps transport/HTTP errors by stage and status.
7. A smoke command exits nonzero for every non-published result. Its non-submitting mode remains a configuration check only because the Worker review gate intentionally prevents browser-side mutation without explicit approval.

## Reconciliation boundary

The documented Douyin list API does not provide a stable request idempotency key for an ambiguous create response. Therefore the correction persists the unknown state and prohibits blind replay. A future webhook or verified platform-specific lookup may call the state store's explicit confirmation operation; it must not infer success from a title match.

## Verification

Tests must first prove profile artifacts are ignored, approval rejects a mismatched snapshot, durable state survives a new adapter instance, unknown state prevents a second platform create, the Worker entrypoint fails closed, browser success waits, transport failures classify correctly, official Douyin endpoint defaults are used, and smoke failures return a nonzero exit status.
