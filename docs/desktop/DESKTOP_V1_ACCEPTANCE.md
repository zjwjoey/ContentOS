# Desktop V1 Acceptance Matrix

This document records current evidence only. `V1_ACCEPTED` requires a clean Windows machine; the current packaged smoke ran on the development Windows machine with an isolated ASCII temporary install and user-data root.

| Capability | Status | Evidence |
| --- | --- | --- |
| Isolated branch/worktree | IMPLEMENTED | `feature/contentos-desktop-v1`; base recorded in `DESKTOP_DISTRIBUTION_CLOSURE_BASE_SHA` |
| Branch scope / migration audit | IMPLEMENTED | `DESKTOP_BRANCH_SCOPE_AUDIT.md`, `DESKTOP_MIGRATION_INTEGRATION_NOTES.md` |
| Runtime Host reuse | IMPLEMENTED | `docs/runtime-startup-v1.md` and runtime packages |
| Secure Electron shell / IPC validation | IMPLEMENTED | `apps/desktop/src/main/main.ts`, `preload.ts` |
| Runtime Manager actual endpoint selection | IMPLEMENTED | `apps/desktop/src/main/runtime-manager.ts`, `packages/runtime-core/src/port.ts` |
| Bundled PostgreSQL lifecycle | TESTED_ON_DEV_MACHINE | `packages/runtime-core/src/postgres`; PostgreSQL 18.4 init/start/health/stop/restart reuse smoke passed |
| User-data/PostgreSQL layout | IMPLEMENTED | `DESKTOP_DATA_LAYOUT.md`; packaged smoke data under isolated userData |
| Bundled FFmpeg/FFprobe | TESTED_ON_DEV_MACHINE | staged resources, version/encoder/checksum doctor passed |
| Runtime resource manifest | TESTED_ON_DEV_MACHINE | `apps/desktop/resources/runtime-manifest.json` generated and SHA256-verified |
| Reproducible packaging pipeline | PACKAGED | `desktop:clean -> desktop:build -> apps/web build -> desktop:doctor -> electron-builder` |
| Windows installer | PACKAGED | CI Run #90 (`36700650858`) uploaded `ContentOS Setup.exe` in artifact `contentos-desktop-windows-25edd0daf9115bc724b3c1d79a5b86531e244f6e` |
| Windows portable executable | PACKAGED | CI Run #90 (`36700650858`) uploaded `ContentOS.exe` in artifact `contentos-desktop-windows-25edd0daf9115bc724b3c1d79a5b86531e244f6e` |
| Packaged runtime smoke | PACKAGED_SMOKE_VERIFIED | CI Run #90 reached `READY_WITH_WARNINGS` for unpacked packaged, portable, and installed artifacts; packaged `EMBEDDED` DB, migration, API, Web and workers READY; authenticated stop released services and PostgreSQL |
| Persistence after reopen | TESTED_ON_DEV_MACHINE | Second packaged launch reused PG_VERSION 18 with unchanged timestamp and migration READY |
| Port conflict recovery | TESTED_ON_DEV_MACHINE | Occupied 3000/3001/3002/55433; selected API 3003, Web 3004, Control 3005, DB 55434 |
| Migration matrix | TESTED_ON_DEV_MACHINE | 9/9 passed against an isolated bundled PostgreSQL 18.4 instance |
| Auto Edit V1 / V1.5 | TESTED_ON_DEV_MACHINE | 28/28 and 20/20 passed against the isolated bundled database |
| Production pipeline | TESTED_ON_DEV_MACHINE | 12/12 passed against the isolated bundled database |
| Digital Human | TESTED_ON_DEV_MACHINE | 64/64 passed, including real FFmpeg output validation |
| Full regression | TESTED_ON_DEV_MACHINE | 288/288 passed, 0 failed, 0 cancelled, 0 skipped |
| Clean Windows acceptance | NOT TESTED | Requires a clean Windows profile/machine with no developer tools |
| Final packaged manifest | TESTED_ON_DEV_MACHINE | Run #90 generated the current `runtime-manifest.json` for commit `25edd0daf9115bc724b3c1d79a5b86531e244f6e`, PostgreSQL 18.4, FFmpeg 6.1.1, FFprobe 4.0.2, and SHA256 values |
| Windows packaging CI | PASS | Run #90 (`36700650858`) passed Quality, Windows Runtime Startup V1, Database/tests, Build, Desktop Windows package/smoke, and Browser/render acceptance; artifact archive digest `sha256:ec35c4f2ad320eedf3255630db63532e384ba4f888460b5ea5177ffca61a6739` |
| Remote branch | PUSHED | `git push origin feature/contentos-desktop-v1` succeeded; local HEAD and `origin/feature/contentos-desktop-v1` are `25edd0daf9115bc724b3c1d79a5b86531e244f6e` |

The final report must distinguish:

- `IMPLEMENTED`: source exists and review completed.
- `TESTED_ON_DEV_MACHINE`: automated or local smoke test passed.
- `PACKAGED`: a real installer/portable artifact was generated.
- `CLEAN_WINDOWS_TESTED`: artifact was tested on a clean Windows machine/profile.
- `V1_ACCEPTED`: all required gates and evidence are complete.

## Known local limitation

The PostgreSQL 18.4 Windows binaries fail `initdb` when their executable/data paths are passed directly through the current Chinese workspace path. The manager uses Windows short paths where available; the packaged smoke was therefore run from an ASCII temporary install/user-data root. A clean-machine acceptance must explicitly include an install path and user profile representative of the release environment.
