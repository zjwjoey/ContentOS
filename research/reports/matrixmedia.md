# MatrixMedia — Phase 1 Report

**Evidence revision:** `a28e73b9d7c23823f9b18acb6e6086a62dd852d5` (`main`).  All paths below are rooted at `research/repos/MatrixMedia`.

## 1. Project

An Electron desktop application for multi-platform content publishing. It exposes GUI, CLI, HTTP API, and MCP entry points over the same local account/publish capabilities.

## 2. Technology stack

Electron + Vue 2/Pinia renderer; Node/Express local server and CLI; Puppeteer-in-Electron/Puppeteer Core for browser automation; JSON/file-backed local data. `package.json` declares the application and `puppeteer-*` dependencies.

## 3. Top-level structure

`src/main` owns Electron, CLI, HTTP and automation services; `src/renderer` owns Vue screens; `src/shared` holds cross-process value objects; `mcp` is a separate TypeScript bridge. This is a desktop modular layout, not a monorepo.

## 4. Core modules

```text
Renderer / CLI / HTTP / MCP
  -> src/main/services/publishVideo.js
  -> src/main/services/puppeteerFile.js
  -> src/main/services/zt/{dy,xhs,ks,sph,tt}.js
  -> platform browser page
```

Scheduled publication is separate in `src/main/services/scheduledPublish.js`; account login/session-window lifecycle is in `accountLoginWindowManager.js` and `cliLogin/*`.

## 5. Data flow

GUI invokes Electron IPC in `src/main/services/ipcMain.js`; HTTP invokes `src/main/server/routes/index.js`; CLI invokes `src/main/cli/index.js`. Both select `publishVideo.js`, which runs a Puppeteer task and reports completion on Electron/IPC channels such as `puppeteerFile-done`. Scheduled records are created and then re-run by `scheduledPublish.js`. Shared account/publish structures live under `src/shared` and local file data is accessed through `src/main/services/dataRequest.js`.

## 6. Communication

Electron IPC, direct service functions, local HTTP, CLI calls, and Puppeteer event replies. There is no durable inter-process job queue or message bus.

## 7. Boundaries

The UI does not automate sites directly; it crosses the Electron IPC boundary. Platform implementations are physically separated in `services/zt`, but `puppeteerFile.js` and `publishVideo.js` still orchestrate known platforms directly. This is a useful boundary for desktop publishing, not a server-grade Publisher boundary.

## 8. Extensibility

Adding a platform requires a new automation implementation plus edits to shared platform metadata (`src/shared/publishPlatforms.js`), routing/orchestration, UI labels/assets, and likely login flow. It is provider-shaped but not a stable registration interface.

## 9. Error handling

Startup has explicit timeout handling in `services/electronStartup.js`; publication translates browser outcomes into event channels; scheduled publication logs failures in `scheduledPublish.js`. Retry, cancellation and persisted progress are limited compared with a durable worker system.

## 10. Data model

Account, account publish settings, proxy settings, publish input/results and scheduled-publication records are evident in `src/shared/account*.js`, `publishResult.js`, and `scheduledPublish.js`. They are local records rather than a unified Content Project relational model.

## 11. Three designs worth learning

1. Keep GUI, CLI, HTTP and MCP as thin entry adapters over the same `publishVideo` service; ContentOS should likewise avoid four divergent publisher implementations.
2. Model login/session ownership explicitly (`accountLoginWindowManager.js`) instead of treating cookies as an unscoped global; ContentOS needs credential scope per account/platform.
3. Place platform-specific browser actions under one folder (`services/zt`) so breakage is localized; ContentOS should formalize this as a typed Publisher Adapter contract.

## 12. Three designs not to copy

1. Direct Electron event channels are not sufficient for server workers, resumable jobs or visible job history.
2. Platform lists and conditionals are spread across orchestrator/shared/UI layers, making a new platform cross-cutting.
3. File-backed desktop state cannot supply ContentOS’s project, audit, analytics and concurrent-worker requirements.

## 13. Reuse grade

**C — design-only.** The source is useful to study for browser-session and entry-adapter patterns, but should not be copied into ContentOS.

## 14. License

`LICENSE` is **GPL-2.0-only**. Learning architecture is fine; incorporating source into proprietary or differently licensed ContentOS would trigger GPL obligations and is out of scope.
