# AutoSocial — Phase 1 Report

**Evidence revision:** `6deb560ee58ea1e6a040e1ee8e6ca269bd1576b5` (`main`). Paths are rooted at `research/repos/AutoSocial`.

## 1. Project

A local multi-account automation dashboard for TikTok, Instagram and YouTube, centered on filesystem queues and browser-driven upload daemons.

## 2. Technology stack

Node.js/CommonJS, Express static dashboard, `node-cron`, browser uploaders, local filesystem state and CLI tooling. `package.json` names the app `autosocial-studio`.

## 3. Top-level structure

`src` contains dashboard/server, accounts, queues, scheduler, daemons and platform uploaders; `web` is static UI; `autodownload` is a supporting watcher; `test` validates operational utilities. It is intentionally compact rather than layered.

## 4. Core modules

```text
Dashboard API / cron daemon
  -> post-service.js
  -> queue.js + platform uploader
  -> queue / posted / failed filesystem folders
```

`dashboard-server.js` also manages account selection and platform daemon controls.

## 5. Data flow

An HTTP action in `dashboard-server.js` starts/runs a daemon or schedules a cron expression. `scheduler.js` calls `postNextFromQueue`; `queue.js` chooses the next video and sidecar caption; `post-service.js` calls an uploader then moves both video and caption to `posted` or `failed` directories. Result state is inferred from filesystem location.

## 6. Communication

Express HTTP in-process calls, `node-cron` callbacks, child/browser processes and filesystem moves. There is no database, queue broker or durable job record.

## 7. Boundaries

The queue selector and posting service are cleanly separated from dashboard route wiring. Platform uploader modules are separate, but the account/daemon/dashboard process shares local runtime state; there is no adapter interface enforced by types/contracts.

## 8. Extensibility

Adding a platform entails an uploader, a queue/daemon variant, account/login endpoints and dashboard labels. It supports multi-account operationally but not as a plug-in registry.

## 9. Error handling

Failures preserve screenshots/errors and move the attempted files to `failed`; missing sidecar captions are tolerated. Cron validates its expression. There is no automatic retry/backoff/idempotency key or audit-grade publish record.

## 10. Data model

Account data and active account selection are managed in `account-manager.js`; a queue item is `{ videoPath, caption, captionPaths }`; outcomes are physical folders and optional screenshot paths. It is a useful operational prototype, not a ContentOS project domain model.

## 11. Three designs worth learning

1. Make the post lifecycle visible through explicit pending/posted/failed outcomes, even in a small tool.
2. Keep queue selection deterministic with an optional random strategy (`queue.js`); ContentOS can record the selected strategy in an Edit/Publish Manifest.
3. Move sidecar metadata together with its asset, preventing the common “video posted but caption lost” failure mode.

## 12. Three designs not to copy

1. Directory location must not be ContentOS’s canonical job state.
2. Cron callbacks cannot deliver durable retry, concurrency controls, cancellation or multi-worker coordination.
3. Coupling dashboard routes to daemon lifecycle will not scale to remote Publisher workers.

## 13. Reuse grade

**B — selective extraction.** Small MIT utilities/patterns for queue-item/sidecar handling are candidates after review; the filesystem runtime should not become the platform foundation.

## 14. License

`LICENSE` is **MIT**. Reuse still requires normal attribution and a security/maintenance audit of browser automation code.
