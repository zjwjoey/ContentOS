# ADR-016: Script Editing V3 Unified uses the existing manifest and frozen material snapshots

## Status

Accepted for the V3 worktree.

## Decision

Script Editing V3 Unified extends `EDIT_MANIFEST_V0` instead of introducing a parallel `ManifestV3`, `AssetV3`, or renderer. A V3 clip is still a `ManifestClip`, with optional `sourceOutMs`, `sentenceId`, `sourceSegmentId`, `locked`, `selectionSource`, and `revision` fields. Legacy manifests remain valid when those fields are absent.

Each editing session stores a `material_pool_snapshot`. The snapshot copies the authorized local-media references and metadata at session creation time, deduplicated by canonical path, file size, and duration. Later folder scans do not mutate an existing snapshot. Candidate ranking is limited to that snapshot.

All V3 changes persist a new immutable `edit_manifests` revision and record an `EditOperationV3`. The renderer only reads the selected source range and timeline fields; candidate selection, replacement, trimming, and locking remain planner/workbench responsibilities.

Long-running folder scans, visual analysis, and renders use the existing durable Job system. Qwen is behind `VisualAnalysisProvider`; invalid provider output is rejected before profile persistence. Jianying import is read-only and records draft usage separately from canonical asset references.

## Compatibility

- V2 script editing, MIX, presentation, subtitle, branding, audio, Pexels, and existing FFmpeg paths remain on their existing contracts.
- V3 uses additive migration `0031_script_editing_v3_unified.sql` with a matching down migration.
- `sourceOutMs` is optional for legacy manifests; when present, FFmpeg validates that it exactly matches `durationMs`.

## Follow-up

Database-backed migration and browser acceptance gates require PostgreSQL and the normal worker/runtime environment. Shot-level detection, richer Jianying material resolution, and multi-frame analysis can be added without changing the V3 manifest boundary.
