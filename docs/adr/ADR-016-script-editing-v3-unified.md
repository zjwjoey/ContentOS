# ADR-016: Script Editing V3 Unified uses the existing manifest and frozen material snapshots

## Status

Accepted for the V3 worktree.

## Decision

Script Editing V3 Unified extends `EDIT_MANIFEST_V0` instead of introducing a parallel `ManifestV3`, `AssetV3`, or renderer. A V3 clip is still a `ManifestClip`, with optional `sourceOutMs`, `sentenceId`, `sourceSegmentId`, `locked`, `selectionSource`, and `revision` fields. Legacy manifests remain valid when those fields are absent.

Each editing session stores a `material_pool_snapshot`. The snapshot copies the authorized local-media references and metadata at session creation time, deduplicated by canonical path, file size, and duration. Later folder scans do not mutate an existing snapshot. Candidate ranking is limited to that snapshot.

All V3 changes persist a new immutable `edit_manifests` revision and record an `EditOperationV3`. The renderer only reads the selected source range and timeline fields; candidate selection, replacement, trimming, and locking remain planner/workbench responsibilities.

Long-running folder scans, visual analysis, and renders use the existing durable Job system. Qwen is behind `VisualAnalysisProvider`; invalid provider output is rejected before profile persistence. Jianying import is read-only and records draft usage separately from canonical asset references.

## Reuse / Extend / New matrix

| Area | Reuse | Extend | New only where the existing boundary had no representation |
| --- | --- | --- | --- |
| Script cleaning, sentence timing, voice gaps | `script-cleaner.ts`, `sentence-segmenter.ts`, `TimedScriptSentence`, `prepareVoiceTiming` | V3 session input carries the confirmed/absolute timing | — |
| Planning, editing, manifest, rendering | `EditorialPlanV1`, `QuickEditOperation`, `EditManifest`, existing FFmpeg renderer | Additive V3 fields and operations (`sourceOutMs`, sentence/source segment identity, lock/manual selection) | — |
| Local media and external media | `LocalPathAccessService`, local-media scan, existing Hybrid/Pexels path | Snapshot references and V3 candidate provenance | — |
| Material pool | Existing Asset/local-media identity and Native Path Picker | Frozen snapshot, folder or explicitly selected-file inputs, health, manual tags, Gold and disabled state | `material_pool_snapshots` and `material_pool_items` |
| Jianying | Existing job, asset and usage infrastructure | Read-only importer adapter and historical usage records | Jianying draft/import usage tables |
| Visual understanding | Existing AI/provider configuration boundary | Qwen visual/query/embedding provider adapters and cached profiles | Visual profiles, tag evidence, representative-frame and embedding persistence |
| Editing UI | Existing `/edit/script` product entry and Workbench primitives | Unified V3 sentence cards, candidate browser, source monitor and full-preview orchestration | No second planner, manifest, renderer, cleaner or Quick Edit implementation |

When Qwen is configured, snapshot creation enqueues the existing `ANALYZE_ASSET_VISUAL` job for each eligible item. The explicit “分析整个素材池” action uses the same job, cache fingerprint and idempotency key for later retry; when Qwen is not configured it leaves the manual path available without creating synthetic AI failures.

## Compatibility

- V2 script editing, MIX, presentation, subtitle, branding, audio, Pexels, and existing FFmpeg paths remain on their existing contracts.
- V3 uses additive migrations `0031_script_editing_v3_unified.sql` through `0037_script_editing_v3_settings.sql` with matching down migrations; `0035` persists the ffprobe FPS/codec fields needed by the frozen pool contract, `0036` binds cached AI results to the frozen media fingerprint, and `0037` persists the existing presentation/audio/editorial settings on the V3 session without introducing a second manifest.
- Representative-frame reuse is keyed by media fingerprint and the persisted `frame_generation_version`; changing the frame strategy cannot silently reuse an old frame set.
- `sourceOutMs` is optional for legacy manifests; when present, FFmpeg validates that it exactly matches `durationMs`.

## Follow-up

Database-backed migration and browser acceptance gates require PostgreSQL and the normal worker/runtime environment. Shot-level detection, richer Jianying material resolution, and multi-frame analysis can be added without changing the V3 manifest boundary.
