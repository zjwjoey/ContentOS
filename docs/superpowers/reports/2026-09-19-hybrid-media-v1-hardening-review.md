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
