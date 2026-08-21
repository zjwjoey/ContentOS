# ContentOS V1 Video Engine Decision

## Non-negotiable boundary

```text
Asset folder + narration audio + planning rules
  -> Video Planner
  -> immutable Edit Manifest
  -> Renderer
  -> MP4 + render artifact
```

The planner is deterministic given a seed and asset metadata. It selects, deduplicates and times scenes; the renderer must not select assets or invent timing.

## Options

| Option | Assessment |
|---|---|
| A. Pure FFmpeg | **Recommended.** Lowest dependency count, direct Windows/GPU behavior, easy process supervision, and manifest-to-command traceability. Basic `cut/fade/crossfade/zoom/slide` and subtitles are sufficient. Preview is a later concern. |
| B. FFmpeg + wrapper | Accept only a thin in-house command builder/validator. Do not make MoviePy a mandatory V1 runtime: direct FFmpeg gives clearer process, hardware and failure control. A wrapper must emit the final command and never hide it. |
| C. FFmpeg + Remotion | Reject for V1. Better template/animation/preview potential, but composition bundle, Chromium render, React implementation and commercial license review outweigh value for random assembly. |

## Decision

Choose **Option A with a tiny typed FFmpeg command builder**. The builder is an internal implementation detail of the Video Worker, not a generic media framework. Persist the planner input snapshot, manifest, generated command, FFmpeg version, encoder decision, logs and artifact checksum.

## Operational rules

- Probe `h264_nvenc`/other accelerators at worker startup; select a documented fallback encoder.
- Give each attempt its own staging directory; promote output only after probe/validation succeeds.
- Kill the FFmpeg process tree on cancellation/timeout; retain stderr and a bounded log excerpt.
- A retry consumes the same immutable manifest unless a user explicitly creates a new render revision.
