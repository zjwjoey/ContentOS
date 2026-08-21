# AI Short Video Factory — Phase 1 Report

**Evidence revision:** `8f83bf320c69f4a81ba017fb9871e255679cd275` (`main`). Paths are rooted at `research/repos/short-video-factory`.

## 1. Project

An Electron desktop app that generates a marketing/content short video from text, selected local materials, TTS and an FFmpeg render operation.

## 2. Technology stack

Vue 3 + Vite + Pinia renderer; Electron main/preload IPC; embedded `ffmpeg-static`; Edge TTS; `better-sqlite3`; TypeScript. The package manager is pnpm.

## 3. Top-level structure

`src` is the Vue UI, `electron` contains privileged main-process capabilities, `native` ships SQLite native binaries, and `build` packages Electron/FFmpeg. It separates desktop presentation from OS/media operations but remains one application process boundary.

## 4. Core modules

```text
Home UI: TextGenerate + VideoManage + TtsControl + VideoRender
  -> preload IPC
  -> electron/ipc.ts
  -> electron/{tts,ffmpeg,sqlite}
  -> output files / local SQLite
```

The composition root is `src/views/Home/index.vue`; media execution is `electron/ffmpeg/index.ts`.

## 5. Data flow

The Vue screen constructs a render request, invokes the preload API, and `electron/ipc.ts` calls `renderVideo`. `electron/ffmpeg/index.ts` converts material clips, narration, optional BGM and SRT subtitle input into an FFmpeg argument/filter graph, while reporting progress and accepting an abort signal. Local UI data can be read/written through `electron/sqlite/index.ts`.

## 6. Communication

Renderer-to-main Electron IPC, then direct TypeScript function calls and child-process FFmpeg. No HTTP API, external worker, durable queue or message bus is present.

## 7. Boundaries

Media code is correctly outside the renderer, but `ipc.ts` exposes generic SQL methods (`sqlite-query`, insert/update/delete) to the renderer. That is an overly broad persistence boundary for a multi-user ContentOS server.

## 8. Extensibility

Render parameters/types in `electron/ffmpeg/types.ts` are the most reusable seam. New effects still entail changing FFmpeg command construction; there is no effect-provider registry or manifest persisted as a first-class object.

## 9. Error handling

`renderVideo` validates output paths, catches spawn/render failures, and supports abort/progress callbacks. The UI uses `RenderStatus` to block conflicting operations. Failures are immediate client-visible errors, not recoverable jobs.

## 10. Data model

The principal model is a transient render configuration plus local SQLite tables accessed through generic query APIs. Inputs include text, files, selected ranges, audio/subtitles and an output destination; it has no content-project/job/asset/post analytics domain model.

## 11. Three designs worth learning

1. A minimal V1 media pipeline should accept explicit material clips, voice, BGM and SRT, then generate a deterministic FFmpeg command and output path.
2. Make cancellation and progress explicit in the render function signature rather than bolting them onto UI state afterward.
3. Keep privileged filesystem, TTS and FFmpeg work outside the reactive UI process.

## 12. Three designs not to copy

1. Do not expose arbitrary SQL operations across the UI boundary.
2. Do not use transient renderer state as the source of truth for server-side render jobs.
3. Do not make Electron the required control plane for ContentOS batch rendering.

## 13. Reuse grade

**C — design-only.** The render flow is a strong V1 reference, but it needs a service/worker rewrite and an Edit Manifest before ContentOS can adopt the concept.

## 14. License

`LICENSE` is **AGPL-3.0**. Treat it as a source-study reference only; do not copy its code into ContentOS.
