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
| Windows installer | PACKAGED | `artifacts/desktop/ContentOS Setup.exe`, 379778142 bytes, SHA256 `8007576F873DC0CCC17885259A0831BCB2530383F359CA8FC736275BC2CD794D` |
| Windows portable executable | PACKAGED | `artifacts/desktop/ContentOS.exe`, 379548440 bytes, SHA256 `63ED0B2042CEFD82E3AAF26A69D72DA2AD35689A8E16C186540F644754DCAF28` |
| Packaged runtime smoke | PACKAGED_SMOKE_VERIFIED | `pnpm desktop:smoke` reached `READY_WITH_WARNINGS`; packaged `EMBEDDED` DB, migration, API, Web and workers READY; authenticated stop released services and PostgreSQL |
| Persistence after reopen | TESTED_ON_DEV_MACHINE | Second packaged launch reused PG_VERSION 18 with unchanged timestamp and migration READY |
| Port conflict recovery | TESTED_ON_DEV_MACHINE | Occupied 3000/3001/3002/55433; selected API 3003, Web 3004, Control 3005, DB 55434 |
| Migration matrix | TESTED_ON_DEV_MACHINE | 9/9 passed against an isolated bundled PostgreSQL 18.4 instance |
| Auto Edit V1 / V1.5 | TESTED_ON_DEV_MACHINE | 28/28 and 20/20 passed against the isolated bundled database |
| Production pipeline | TESTED_ON_DEV_MACHINE | 12/12 passed against the isolated bundled database |
| Digital Human | TESTED_ON_DEV_MACHINE | 64/64 passed, including real FFmpeg output validation |
| Full regression | TESTED_ON_DEV_MACHINE | 288/288 passed, 0 failed, 0 cancelled, 0 skipped |
| Clean Windows acceptance | NOT TESTED | Requires a clean Windows profile/machine with no developer tools |
| Final packaged manifest | TESTED_ON_DEV_MACHINE | `runtime-manifest.json` records commit `8be5c38c63eb9fbd6f4d7c8f96059a9443c56a83`, PostgreSQL 18.4, FFmpeg 6.1.1, FFprobe 4.0.2, and SHA256 values |
| Windows packaging CI | CONFIGURED | `.github/workflows/ci.yml` now triggers on `feature/contentos-desktop-v1`, builds both Windows artifacts, runs `desktop:smoke`, and uploads installer/portable/manifest artifacts |
| Remote branch | PUSHED | `git push origin feature/contentos-desktop-v1` succeeded; direct `git fetch origin` verified local HEAD equals `origin/feature/contentos-desktop-v1` at `8fd220e69b45f5f648e9f217b4e83111ef1ac5b3` |

The final report must distinguish:

- `IMPLEMENTED`: source exists and review completed.
- `TESTED_ON_DEV_MACHINE`: automated or local smoke test passed.
- `PACKAGED`: a real installer/portable artifact was generated.
- `CLEAN_WINDOWS_TESTED`: artifact was tested on a clean Windows machine/profile.
- `V1_ACCEPTED`: all required gates and evidence are complete.

## Known local limitation

The PostgreSQL 18.4 Windows binaries fail `initdb` when their executable/data paths are passed directly through the current Chinese workspace path. The manager uses Windows short paths where available; the packaged smoke was therefore run from an ASCII temporary install/user-data root. A clean-machine acceptance must explicitly include an install path and user profile representative of the release environment.
