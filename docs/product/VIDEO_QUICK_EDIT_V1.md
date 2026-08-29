# Standalone Quick Edit V1

Standalone Quick Edit is a no-Project video workflow:

```text
Video / Voice upload
→ READY Asset Import
→ Standalone Video Workspace
→ Random Montage Planner
→ Manifest V1 preview
→ Video Adjustment revisions
→ Exact Render Job
→ shared Video Worker / FFmpeg
```

It never creates a fake `ContentProject`. A `STANDALONE` `video_workspace` owns the session, workspace asset links, manifests, renders and jobs. A voice asset's measured FFprobe duration drives the target timeline when no explicit target duration is supplied.

Defaults are 9:16, 1080×1920, 30fps, CUT transitions, 2–5 second clips, deterministic seed and exact final-duration fill by the last clip. Asset uploads use the existing Asset Import and Asset Worker path and become READY before planning.

Primary routes:

- `POST /api/v1/video/quick-edits`
- `POST /api/v1/video/quick-edits/:id/assets`
- `POST /api/v1/video/quick-edits/:id/plan`
- `GET /api/v1/video/quick-edits/:id/manifests`
- `POST /api/v1/video/quick-edits/:id/adjustments`
- `POST /api/v1/video/quick-edits/:id/manifests/:manifestId/render`

