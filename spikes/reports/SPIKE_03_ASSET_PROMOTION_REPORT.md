# Spike 03 Asset Staging and Promotion Report

## Result

**PASS WITH CONDITIONS**

The local filesystem spike verified checksum-addressed staging, Unicode filenames, deduplication, atomic promotion and crash-window cleanup. The result is conditional because this validates a local filesystem primitive only; cloud/object-store semantics, multipart uploads and cross-device rename behavior still require a provider-specific spike before production selection.

## Scenario results

| Scenario | Result | Evidence |
|---|---|---|
| SHA-256 content address | PASS | Promoted object path is derived from the verified SHA-256 digest |
| Duplicate content | PASS | Second identical asset returned `DEDUPED` and reused the canonical object |
| Unicode path and metadata | PASS | `素材-中文.mp4` retained in UTF-8 metadata and source path |
| Checksum mismatch | PASS | Promotion blocked with structured `CHECKSUM_MISMATCH`; staged evidence retained |
| Crash after copy, before rename | PASS | No final object was visible; stale `.part-*` files were removed by cleanup |
| Atomic success | PASS | Final object and metadata were atomically renamed; no `.part` files remained |

## Environment and boundary

- Windows local host; Node.js 24.14.0 / npm 11.9.0.
- Store root is a disposable temporary directory under the local filesystem.
- No cloud bucket, external account, real credential or ContentOS product directory was used.
- Evidence: `SPIKE_03_TEST_OUTPUT.txt`, `SPIKE_03_RUN_SUMMARY.json`, `SPIKE_03_ENV.json`.

## Findings

1. Staging must be separate from the content-addressed object namespace; a staged file is not a published asset.
2. The promotion path should verify the staged bytes again, then use a same-filesystem temporary object and atomic rename.
3. Deduplication is naturally keyed by SHA-256, while original filename and asset identity remain metadata rather than storage identity.
4. Cleanup must cover both staging `.part` files and object/metadata temporary files left by a process crash.

## Architecture V0 change request

- Keep checksum-addressed identity and atomic promotion as the V0 asset contract.
- Require a cleanup/reconciliation job for stale staging and promotion temporary files.
- For an object-store adapter, require an equivalent conditional-create/complete protocol and an explicit “promotion committed” marker; do not assume local `rename` semantics transfer to a remote bucket.
- Preserve original Unicode names as metadata and never use user-controlled names as an unsanitized storage path segment.

## Decision

The V0 asset staging boundary is **PASS WITH CONDITIONS** for a local filesystem implementation. Provider-specific object storage remains an explicit follow-up validation item. No formal ContentOS product code was created.
