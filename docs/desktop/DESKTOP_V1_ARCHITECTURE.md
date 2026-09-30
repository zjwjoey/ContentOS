# ContentOS Desktop V1 Architecture

## Scope

Desktop V1 is an Electron shell around the existing ContentOS Web application and
Runtime Startup V1. The desktop process owns the window, secure IPC, single-instance
behavior, and user-facing runtime diagnostics. The Runtime Host remains the owner of
API, Web, PostgreSQL migration, worker startup, health, restart, and shutdown.

The desktop layer must not import business services or bypass the Runtime Client.
Business modules continue to use PostgreSQL and the existing API contracts.

## Baseline and reuse decision

The feature branch is based on `codex/runtime-launcher-v1` at `aea974c07349854402474134df1c6b32589fd48c`.
That branch already provides:

- `packages/runtime-core`: service definitions, process manager, port checks, paths,
  instance guard, supervisor, state files, and doctor contracts.
- `packages/runtime-client`: lifecycle client for start, status, doctor, logs,
  restart, and stop.
- `apps/runtime-host`: dependency-ordered startup of API, Web, database migration,
  and workers.

Desktop V1 adds an Electron main/preload/renderer boundary and package metadata. It
does not replace the existing developer operator (`scripts/dev-operator.ts`) or the
CLI (`pnpm contentos`).

## Process model

```text
Electron main process
  ├─ Desktop Runtime Manager (RuntimeClient adapter)
  │    └─ Runtime Host child process
  │          ├─ migration task / PostgreSQL check
  │          ├─ API
  │          ├─ workers
  │          └─ Web (Next production server)
  ├─ BrowserWindow (localhost Web URL only)
  └─ preload (typed, allow-listed IPC)
```

The renderer never receives Node access, filesystem access, shell access, database
credentials, or arbitrary IPC channels. The preload exposes only the Desktop API in
`packages/desktop-contract`.

## Startup and shutdown

1. Electron requests the single-instance lock.
2. Main resolves portable/user-data paths and allocates a runtime control port.
3. Runtime Manager calls `RuntimeClient.start()` with `CONTENTOS_RUNTIME_MODE=PACKAGED`
   for a packaged app, or `DEVELOPMENT` for `desktop:dev`.
4. Main waits for `READY` or `READY_WITH_WARNINGS`, then loads the local Web URL.
5. Main publishes status changes to the renderer at a bounded interval and on state
   transitions.
6. On quit, main asks Runtime Client to stop, waits for the process tree, then exits.
   If graceful stop exceeds the bounded timeout, the existing Windows tree-kill
   behavior is used by Runtime Host.

Electron does not expose a separate Node executable in the packaged application. The
desktop main process sets `CONTENTOS_ELECTRON_RUNTIME=1`; Runtime Client then launches
the same Electron binary with `ELECTRON_RUN_AS_NODE=1`, preserving the existing child
process contract for Runtime Host and its workers.

## Protected boundaries

- PostgreSQL remains the source of truth; Desktop never creates SQLite data.
- User data is outside the install directory and is resolved through RuntimePaths.
- Runtime state/logs/startup reports are diagnostic artifacts, not business data.
- Ports are configurable and persisted only as runtime state; no fixed global port is
  required for future multi-instance or test profiles.
- Existing Web/API/worker commands stay valid and are not routed through Electron.

## Known packaging constraint

The current Runtime Host packaged mode expects the compiled repository-relative
runtime layout and production Next assets. The Desktop packaging implementation must
stage that layout explicitly and fail with a diagnostic when a required artifact is
missing; it must not silently fall back to source runners or `pnpm`.
