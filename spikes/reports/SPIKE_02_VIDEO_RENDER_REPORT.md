# Spike 02 Video Render Report

## Result

**PASS WITH CONDITIONS**

The seeded `EDIT_MANIFEST_V0` planner and thin FFmpeg command builder produced five real 1080x1920 MP4 outputs. All five automated scenarios passed, and extracted frames confirmed visible Chinese UTF-8 subtitles rendered with the explicit Windows Microsoft YaHei font. The result is conditional because the PATH FFmpeg is an old 2014 build; a supported FFmpeg build and the explicit fontfile/fallback behavior must be fixed in the engineering runtime contract.

## Environment

| Item | Value |
|---|---|
| Operating system | Windows local development host |
| Node.js / npm | 24.14.0 / 11.9.0 |
| FFmpeg | `N-62439-g5e379cd` (PATH, 2014 build) |
| ffprobe | `8.1.2-full_build-www.gyan.dev` |
| Target | 1080x1920, 30 fps, MP4 |
| Font | `C:\Windows\Fonts\msyh.ttc` (present) |
| Inputs | 10 generated MP4s: landscape, portrait and square; mixed resolution/FPS/duration |
| Audio / captions | 30-second WAV; UTF-8 `中文字幕.srt` |

## Scenario results

| Scenario | Result | Evidence |
|---|---|---|
| Seeded planner repeatability | PASS | Same seed produces byte-equivalent manifest; adjacent source references differ |
| Manifest -> portrait MP4 | PASS | `seed-11.mp4` probes to 1080x1920 and 30 seconds |
| Five deterministic render seeds | PASS | `seed-1.mp4` through `seed-5.mp4`; all probe to 1080x1920, 30 seconds |
| Chinese path / UTF-8 subtitle / Windows font | PASS | `中文字幕.srt` and `素材-中文-10.mp4`; visual frames at 7s and 17s show Chinese text |
| Corrupted input media | PASS | Structured `FFMPEG_FAILED`; no planner crash and no false success |
| Invalid manifest | PASS | Structured `MANIFEST_INVALID` before invoking FFmpeg |
| Interrupted render | PASS | Structured `RENDER_INTERRUPTED`; temporary output removed |
| Transition behavior | PASS | Per-clip fade-in/fade-out; no hard-cut-only timeline |

## Findings

1. A declarative Manifest can be rendered by a thin builder without moving asset selection or timing decisions into FFmpeg code.
2. Mixed input aspect ratios can be normalized deterministically with scale/crop to the portrait target.
3. The available legacy FFmpeg build reports a libass/fontconfig warning and does not expose a `fontsdir` option. The spike therefore parses the UTF-8 SRT and emits explicit `drawtext` overlays using `msyh.ttc`; this made Chinese subtitle rendering observable and repeatable on Windows.
4. Rendering uses a temporary file with the final `.mp4` extension and atomically renames only after FFmpeg succeeds, preventing partial output promotion.
5. FFmpeg is CPU-bound in this fixture and no GPU path was assumed or tested; production throughput and hardware acceleration remain open validation work.

## Architecture V0 change request

- Keep `EDIT_MANIFEST_V0` as the renderer boundary and keep the renderer deterministic and side-effect-limited to its output directory.
- Record the supported FFmpeg build, codec capabilities and Windows font packaging as an explicit runtime contract.
- Treat subtitle rendering as a capability check: the worker must fail with structured diagnostics when the configured font is absent, rather than silently producing a video without captions.
- Keep atomic output promotion and retain the Manifest/provenance/seed alongside render evidence.

## Decision

The V0 rendering boundary is **PASS WITH CONDITIONS**. It is suitable for the next spike, subject to pinning a supported FFmpeg distribution and formalizing font/subtitle capability checks. No formal ContentOS product code was created.
