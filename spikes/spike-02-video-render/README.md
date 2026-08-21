# Spike 02: EDIT_MANIFEST_V0 -> FFmpeg -> MP4

Disposable validation code for the V0 Video boundary. It is intentionally a seeded planner and thin FFmpeg command builder, not a production video module.

## Prerequisites

- Node.js 22+
- `ffmpeg` and `ffprobe` on `PATH`
- Windows `C:\Windows\Fonts\msyh.ttc`; the subtitle fixture is UTF-8 Chinese text. The spike emits explicit `drawtext` overlays because the legacy PATH FFmpeg has no usable fontconfig database.

## Run

```powershell
npm test
npm run run
```

The fixture generator creates ten local MP4 inputs with mixed landscape, portrait, square, resolutions, frame rates and durations, plus a 30-second WAV voice track and `中文字幕.srt`. `npm run run` renders five different random seeds and writes a JSON summary under `outputs/`.

The renderer consumes only `EDIT_MANIFEST_V0`, uses a thin filter builder, scales/crops to 1080x1920, applies fade transitions, overlays subtitles with the explicit Microsoft YaHei font and maps the voice track. It never selects assets or changes clip timing while rendering.
