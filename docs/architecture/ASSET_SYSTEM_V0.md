# Asset System V0

Asset is the canonical record for source media and generated artifacts. Business modules reference Asset IDs; only Asset resolves a storage key to a signed/local-access locator.

## Model

`Asset(kind, checksum, byte_size, media_metadata, storage_key, lifecycle)` supports video, audio, image, subtitle, document, manifest and render output. `AssetDerivative` links thumbnails, waveform/probe results and transcoded forms to a parent Asset. `ProjectAsset` declares role: `SOURCE_MATERIAL`, `VOICE`, `SUBTITLE`, `RENDER_OUTPUT`, `PUBLISH_COVER`.

## Storage rules

- Use a storage adapter: local filesystem first, object storage later; stable Asset IDs keep callers independent of backend.
- Upload/create to a staging key, probe/checksum, promote atomically, then mark Asset `READY`.
- Worker staging directories are temporary and not canonical storage.
- Retention/cleanup is an Asset-owned Job and must consider references, Job attempts and legal/audit policy.
- Asset maintenance includes reconciliation scans for orphan blobs, missing blobs and stale staging/promotion temporary files. A local filesystem may use atomic rename; a remote adapter must provide an equivalent conditional commit/complete protocol before it is selected.
