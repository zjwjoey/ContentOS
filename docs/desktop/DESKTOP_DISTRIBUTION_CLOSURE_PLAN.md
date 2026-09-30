# ContentOS Desktop V1 Distribution Closure Plan

## 1. Current audit baseline

- Branch: `feature/contentos-desktop-v1`
- Local HEAD: `44f73363de250de648f999cbcebf40931e85c6cb`
- Local `origin/feature/contentos-desktop-v1`: `44f73363de250de648f999cbcebf40931e85c6cb`
- `git fetch origin` was attempted on 2026-09-30 but could not connect to GitHub through the configured proxy. The remote-tracking ref is therefore recorded as the last locally known value, not as proof of current server state.
- Working tree contains uncommitted distribution changes. They are treated as in-scope work in progress and will be reviewed before commit.
- `DISTRIBUTION_CLOSURE_BASE_SHA`: `44f73363de250de648f999cbcebf40931e85c6cb`
- No merge from `main` is planned. The Intelligent Editing worktree/branch remains untouched.

## 2. Objective and acceptance boundary

The objective is a self-contained Windows x64 distribution that can be installed or run portably on a machine without Node.js, pnpm, PostgreSQL, FFmpeg, FFprobe, Git, or the source checkout. The acceptance path is:

`install or launch -> private PostgreSQL -> migrations -> API/Web/workers -> create project -> import video -> real bundled-FFmpeg render -> clean shutdown -> reopen -> persisted data -> repeat render`.

`electron-builder` success, a Runtime Host `READY` state, or a developer-machine smoke test alone is not sufficient for `V1_ACCEPTED`.

## 3. Branch scope and integration hygiene

The branch contains Desktop shell/runtime work based on the Runtime Startup ancestry. Before final merge review we will classify commits and changed files into:

1. Desktop-only shell, packaging, diagnostics, and acceptance work.
2. Runtime Startup foundations required by Desktop.
3. Shared business/runtime changes that need independent review.
4. Digital Human or other feature changes that must not be silently included.
5. Migration files and possible number collisions.

The current known collision is migration `0047_digital_human_duration` on the Desktop ancestry versus `0047_intelligent_editing_v15` on the Intelligent Editing line. This round will not rewrite the other branch or silently renumber its migrations. The integration note will specify a future inventory/renumbering procedure.

## 4. Distribution blockers found at planning time

1. PostgreSQL is still represented by an external database contract in the baseline; packaged mode needs a private, bundled lifecycle.
2. FFmpeg/FFprobe packaging and runtime path ownership need proof that the worker uses staged binaries rather than system PATH.
3. Port allocation must cover API, Web, Runtime Control, and PostgreSQL and persist the actual allocated endpoints in runtime state.
4. Packaging must clean stale `dist`/`.next` output, build all required entries, stage resources, run the expanded doctor, and then invoke electron-builder.
5. Existing acceptance documentation is stale relative to the current branch (`a46ac6d` is recorded while the branch is now at `44f7336`). It must be updated only with evidence from current artifacts.
6. CI does not currently push-trigger `feature/contentos-desktop-v1` and has no dedicated Windows packaging/artifact job.
7. Clean Windows evidence, including real media import/render, restart persistence, port conflicts, crash recovery, and orphan-process checks, is not yet present.
8. The current worktree has uncommitted implementation changes; these must pass focused tests and be split into reviewable closure commits.

## 5. Reusable architecture to preserve

- `packages/runtime-core`: path, configuration, process, instance, state, registry, supervisor, and port primitives.
- `packages/runtime-client`: Runtime Host control protocol and status/log/doctor calls.
- `apps/runtime-host`: service definitions, startup ordering, migration gate, and worker supervision.
- `apps/desktop`: Electron shell, preload boundary, runtime manager, failure page, and packaging configuration.
- Existing immutable install-root versus mutable user-data-root separation.
- Existing optional-service semantics for Digital Human, Publisher, and Benchmark. Missing optional credentials must produce warnings, not make the core offline package unusable.

## 6. Implementation phases

### D0 - branch and scope audit

- Record the verified base SHA and fetch result.
- Add `DESKTOP_BRANCH_SCOPE_AUDIT.md` and `DESKTOP_MIGRATION_INTEGRATION_NOTES.md`.
- Review the complete diff and separate Desktop closure changes from unrelated feature ancestry.
- Do not merge `main`, rebase the pushed branch, or modify Intelligent Editing migrations.

### D1 - bundled PostgreSQL runtime

- Add a small PostgreSQL runtime manager or equivalent runtime-core boundary.
- Stage pinned Windows x64 PostgreSQL binaries under package resources.
- Use a private data root under Electron `userData`, never the install directory.
- Implement first-run `initdb`, private loopback configuration, dynamic port allocation, database/role creation, health checks, cluster-major compatibility checks, graceful `pg_ctl` stop, stale PID handling, and bounded force cleanup only after timeout.
- Keep development `DATABASE_URL` external by default and support packaged bundled mode with an explicit override.
- Expose redacted database mode/port/version diagnostics only.

### D2 - bundled FFmpeg/FFprobe

- Stage pinned Windows binaries and a resource manifest with source, version, license, and SHA256 metadata.
- Resolve packaged `FFMPEG_PATH` and `FFPROBE_PATH` from staged resources; retain explicit development overrides.
- Doctor must verify existence, executability, version output, H.264 capability, and AAC capability.
- Do not download media tools at runtime.

### D3 - runtime port allocation

- Allocate bounded, conflict-aware ports for Control, API, Web, and PostgreSQL.
- Keep reservations distinct within a startup attempt and write the selected values to Runtime State.
- Make Electron and Runtime Client consume the actual Web endpoint from the runtime snapshot rather than recomputing the preferred port.
- Add occupied-port and exhaustion tests.

### D4 - reproducible packaging

- Split clean, web build, runtime build, resource staging, doctor, package, and smoke commands.
- Remove stale `.next`/`dist` before a package build.
- Stage only the production runtime files/dependencies required by the packaged layout.
- Ensure packaged startup does not require pnpm, tsx, TypeScript source, developer checkout, system Node, PostgreSQL, or FFmpeg.
- Preserve asar/extraResources decisions explicitly and document any known limitation.

### D5 - diagnostics and resource manifest

- Validate the resource manifest before service startup.
- Add runtime version, launch mode, app/user-data roots, database mode/port/version, API/Web/Control ports, and FFmpeg/PostgreSQL versions to redacted status/startup reports.
- Add explicit distribution error codes and failure-page guidance with log/report paths.
- Add bounded disk log rotation.
- Harden IPC input validation and external-link scheme/host handling.

### D6 - installer and portable validation

- Build both `ContentOS Setup.exe` and `ContentOS.exe` portable outputs.
- Verify install, launch, close, restart, uninstall, user-data retention, and portable mutable-data placement.
- Record artifact filename, size, SHA256, and local path without committing binaries.

### D7 - clean Windows acceptance

- Use a clean Windows x64 environment without developer tools or a source checkout.
- Exercise project creation, real video import, Asset READY, real bundled-FFmpeg render, playback/ffprobe verification, clean shutdown, restart persistence, three start/stop cycles, port conflicts, forced Electron termination/recovery, ordinary-user execution, and mutable-data placement.
- Preserve concise evidence under `docs/desktop/evidence/` or `artifacts/desktop/acceptance/`; do not commit large binaries.

### D8 - final merge-readiness audit

- Run all required format, lint, typecheck, build, runtime, migration, auto-edit, production-pipeline, Web, Desktop, packaging, and Windows gates.
- Run `pnpm test` and record passed/failed/skipped counts and known pre-existing failures separately.
- Re-check scope, migration collisions, artifact hashes, CI status, and remote synchronization.
- Push only `feature/contentos-desktop-v1`; do not merge `main`.
- Report `V1_ACCEPTED` only after clean Windows evidence proves the complete acceptance path. Otherwise report the precise lower state, such as `PACKAGED_SMOKE_VERIFIED` or `AWAITING_CLEAN_WINDOWS_ACCEPTANCE`.

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Bundled PostgreSQL binary/source/license is unclear | Pin version/platform/source/checksum before staging; record notices; fail the package gate if absent. |
| Existing `embedded-postgres` dependency does not provide a redistributable Windows bundle | Treat it as an implementation aid only until its runtime artifacts and license are verified; use explicit staged PostgreSQL resources for acceptance. |
| Port check/use race | Allocate within one startup sequence, reserve values in state, and let service bind failures return a typed allocation error with bounded retry. |
| Stale developer build output | Clean output directories before every package build and make the doctor inspect the staged layout. |
| Electron install root is writable/used for mutable state | Resolve all database, storage, logs, config, and reports from userData and assert this in smoke tests. |
| Migration number collision at future integration | Keep branches separate now; inventory both lines and renumber only during an explicit integration reconciliation. |
| Clean Windows environment unavailable in this workspace | Keep the goal active, finish all reproducible local/package gates, and do not claim `CLEAN_WINDOWS_TESTED` without external clean-machine evidence. |
| Remote fetch unavailable | Preserve the failed fetch evidence, retry before final push, and compare local HEAD with the freshly fetched remote ref before reporting push success. |

## 8. Definition of done

The closure is complete only when the final report can fill every required acceptance field with current evidence, including bundled PostgreSQL, bundled FFmpeg/FFprobe, reproducible installer and portable artifacts, real project/media/render behavior, clean shutdown with no orphan processes, persistence after restart, port-conflict recovery, CI status, and remote push status. Until then the branch remains open for implementation and verification.
