# EDIT_MANIFEST_V0

## Purpose

The manifest is a versioned, immutable rendering instruction and audit record—not a user-editable professional timeline. It makes every scene inspectable and lets a renderer be replaced without altering planning history.

```json
{
  "schema_version": "EDIT_MANIFEST_V0",
  "project_id": "cp_20260821_001",
  "render_id": "rnd_001",
  "plan_revision": 1,
  "seed": "optional-repeatable-selection-seed",
  "resolution": { "width": 1080, "height": 1920 },
  "fps": 30,
  "audio": { "asset_id": "ast_voice_001", "uri": "assets/audio/voice.mp3", "duration": 59.82 },
  "duration": 59.82,
  "scenes": [
    {
      "scene_id": "sc_001",
      "source_asset_id": "ast_video_003",
      "source_uri": "assets/video/003.mp4",
      "source_start": 12.4,
      "source_end": 17.9,
      "timeline_start": 0,
      "timeline_end": 5.5,
      "transition": { "type": "cut", "duration": 0 }
    }
  ],
  "subtitle": { "asset_id": "ast_srt_001", "uri": "assets/subtitles/voice.srt", "style_preset": "v0.default" },
  "output": { "format": "mp4", "video_codec": "h264", "audio_codec": "aac", "uri": "renders/rnd_001.mp4" }
}
```

## Rules

- Scene source and timeline intervals are half-open seconds `[start,end)`; all durations must be positive and contiguous subject only to declared transition overlap.
- V0 allows `cut`, `fade`, `crossfade`, `zoom` and `slide`; unknown transition types fail validation before a worker claim.
- `asset_id` is authoritative; `uri` is an immutable resolved locator for reproducibility. Do not store a mutable folder glob as a scene source.
- Future `overlay`, `logo`, `text`, `animation`, `filter`, `speed`, `crop`, `zoom`, `bgm` and generated footage belong in additive optional fields or a V1 schema, never renderer-private undocumented data.
