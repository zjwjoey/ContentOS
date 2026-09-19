# Hybrid Media Script Editing V1 — Hardening Review

Base SHA: `7961b5e04f99544159d600865622bc16e8f0e248`
Branch: `codex/hybrid-media-script-editing-v1`

## Initial finding matrix

| Finding | Initial status | Evidence |
| --- | --- | --- |
| Segment → selected asset is preserved through Manifest | OPEN | Resolver returned only an ordered asset list; `buildScriptMontageManifest` re-ranked the full pool. |
| Entity classification distinguishes proper entities from concepts | OPEN | Any 2–8 Chinese characters were treated as entities. |
| Authentic entity protection and neutral fallback role | PARTIAL | Local entity score was preferred, but no resolved role/provenance was persisted. |
| Pexels file quality/ranking | OPEN | Portrait distance sort was reversed and did not enforce quality policy. |
| Persistent search cache | OPEN | Cache was process-local `Map`. |
| Provider-identity download cache | OPEN | Only checksum dedupe happened after downloading. |
| External asset provenance | OPEN | `ImportAssetInput` had no metadata extension. |
| Staging cleanup on every failure | PARTIAL | Cleanup happened only after successful import. |
| SSRF/size/redirect/abort safeguards | FIXED | HTTPS host allowlist, redirect bound, content type, byte limit and abort are present. |
| GET provider status avoids network calls | OPEN | GET invoked `provider.health()`. |
| Source UI placement and unconfigured state | PARTIAL | Toggle was under Advanced settings and unconfigured state was not disabled/actionable. |
| Copy task preserves `usePexels` | OPEN | Config endpoint omitted the setting. |
| History source stats and phases | PARTIAL | API exposed fields, UI did not render source counts and only had two phase labels. |
| External-only and graceful fallback | PARTIAL | API allowed empty roots, but failure messaging, resolved evidence and final binding were incomplete. |
| Default unit/integration/browser gates | OPEN | Hybrid unit test was not in `pnpm test`; browser harness did not include a Hybrid E2E. |

This review is the starting audit; the implementation report records the final
status and concrete gate counts after the fixes below.

## Final status matrix

| Finding | Final status | Evidence |
| --- | --- | --- |
| Segment → selected asset is preserved through Manifest | FIXED | Resolved assignments are consumed by exact `assetId` in the montage manifest; integration test covers A/B/C ordering. |
| Entity classification distinguishes proper entities from concepts | FIXED | Known-entity registry plus concept/stopword filtering. |
| Authentic entity protection and neutral fallback role | FIXED | Local-first threshold, explicit `entityFallback`, `AUTHENTIC_ENTITY`/`NEUTRAL_BROLL`/`PLACE_CONTEXT` roles. |
| Pexels file quality/ranking | FIXED | Portrait-first, 9:16 distance, preferred resolution tier and HTTPS host allowlist. |
| Persistent search cache | FIXED | `external_media_search_cache`; second DB-backed resolve does not call provider search. |
| Provider-identity download cache | FIXED | `external_media_assets` lookup prevents a second provider download. |
| External asset provenance | FIXED | External relation stores provider asset/file identity and JSON provenance; asset metadata carries external identity. |
| Staging cleanup on every failure | FIXED | `finally` removes the staging path. |
| SSRF/size/redirect/abort safeguards | FIXED | HTTPS host allowlist, bounded redirects, content type, byte limit and abort. |
| GET provider status avoids network calls | FIXED | GET reads cached status; POST performs and persists health. |
| Source UI placement and unconfigured state | FIXED | Source controls are outside Advanced with Settings action and unknown-state handling. |
| Copy task preserves `usePexels` | FIXED | Copy/config path carries the source toggle. |
| History source stats and phases | FIXED | API and UI expose source counts and phase labels. |
| External-only and graceful fallback | FIXED | Browser and integration coverage include external-only retrieval, local fallback warnings and clear no-source error. |
| Default unit/integration/browser gates | FIXED | Hybrid tests are registered in `pnpm test`; browser harness runs 3/3 flows. |
