# Edit Manifest V0

## Purpose

`EDIT_MANIFEST_V0` is the immutable, declarative contract from creative planning to rendering. It is not an FFmpeg command, a UI timeline format, nor an instruction for the renderer to make creative decisions.

## Envelope

| Field | Meaning |
|---|---|
| `schemaVersion` | literal `EDIT_MANIFEST_V0` |
| `manifestId`, `revision` | stable identifier and immutable revision |
| `projectId`, `storyboardRevisionId` | source provenance |
| `target` | aspect ratio, width/height, fps, audio and output container profile |
| `timeline` | ordered tracks and clips with explicit timing |
| `sources` | immutable Asset IDs, derivative IDs and expected checksums |
| `operations` | declared transform, crop, speed, caption, transition or audio-mix operations |
| `output` | naming policy, expected duration range and validation requirements |
| `provenance` | planner/prompt/tool version, author and creation timestamp |

## Timeline model

`timeline.video[]`, `timeline.audio[]` and `timeline.captions[]` are arrays sorted by `(startMs, zIndex, id)`. A clip has `sourceRef`, `sourceInMs`, `sourceOutMs`, `startMs`, and an explicit operation list. Captions have text, start/end, style reference and safe-area policy. All time values are integers in milliseconds.

## Invariants

1. A Manifest revision is append-only after persistence.
2. Every source reference resolves to a canonical Asset or immutable derivative with its expected checksum.
3. `sourceOutMs > sourceInMs`, `endMs > startMs`, and durations must be positive.
4. Overlap is permitted only when its track and operation semantics define it; otherwise it is validation failure.
5. The final timeline duration must fall inside `output.expectedDurationRangeMs`.
6. User-visible text, transition selection, crop and ordering are explicit values, never renderer defaults.
7. The renderer rejects unsupported schema or operations rather than approximating them.
8. Secrets, absolute workstation paths and browser/platform state are forbidden.

## Compatibility

Schema versions are immutable. A renderer declares the manifest versions and operation capabilities it supports. Migration creates a new manifest revision and retains the original. V0 has no silent forward compatibility.

## Example shape (illustrative)

```json
{
  "schemaVersion": "EDIT_MANIFEST_V0",
  "target": {"width": 1080, "height": 1920, "fps": 30},
  "sources": [{"assetId": "asset_01", "checksum": "sha256:..."}],
  "timeline": {"video": [{"sourceRef": "asset_01", "sourceInMs": 0, "sourceOutMs": 3200, "startMs": 0}]}
}
```

The illustrative shape is not a complete JSON Schema. Formal implementation must publish a machine-readable schema and conformance fixtures before the first renderer is built.
