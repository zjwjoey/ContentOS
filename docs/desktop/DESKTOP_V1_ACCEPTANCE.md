# Desktop V1 Acceptance Matrix

This document records current evidence. The final Windows gates ran on a hosted Windows runner with a fresh isolated install/user-data root, sanitized PATH, and no external database/media/provider environment variables.

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
| Windows installer | PACKAGED | CI Run #95 (`36714930273`) uploaded `ContentOS Setup.exe` in artifact `contentos-desktop-windows-038c7c5b7d7ce5b310b64d658eb666f1fe8219cc` |
| Windows portable executable | PACKAGED | CI Run #95 (`36714930273`) uploaded `ContentOS.exe` in artifact `contentos-desktop-windows-038c7c5b7d7ce5b310b64d658eb666f1fe8219cc` |
| Packaged runtime smoke | PACKAGED_SMOKE_VERIFIED | CI Run #95 reached `READY_WITH_WARNINGS` for unpacked packaged, portable, and installed artifacts; packaged `EMBEDDED` DB, migration, API, Web and workers READY; authenticated stop released services and PostgreSQL |
| Installer uninstall / user-data retention | CLEAN_WINDOWS_TESTED | CI Run #95 Installer runtime smoke installed and launched the app, silently uninstalled it, verified the installed executable/uninstaller disappeared, and verified user-data `data/postgres/PG_VERSION` remained |
| Persistence after reopen | CLEAN_WINDOWS_TESTED | CI Run #95 clean acceptance created a project and imported asset, simulated a crash, restarted, verified project/source asset persistence, then completed three more stop/start cycles with unchanged PG_VERSION |
| Port conflict recovery | CLEAN_WINDOWS_TESTED | CI Run #95 clean acceptance occupied preferred ports 3000/3001/3099/55433; runtime selected dynamic free ports and completed the full project/render flow |
| Migration matrix | TESTED_ON_DEV_MACHINE | 9/9 passed against an isolated bundled PostgreSQL 18.4 instance |
| Auto Edit V1 / V1.5 | TESTED_ON_DEV_MACHINE | 28/28 and 20/20 passed against the isolated bundled database |
| Production pipeline | TESTED_ON_DEV_MACHINE | 12/12 passed against the isolated bundled database |
| Digital Human | TESTED_ON_DEV_MACHINE | 64/64 passed, including real FFmpeg output validation |
| Full regression | TESTED_ON_DEV_MACHINE | 288/288 passed, 0 failed, 0 cancelled, 0 skipped |
| Clean Windows acceptance | CLEAN_WINDOWS_TESTED | CI Run #95 (`36714930273`) passed install, embedded PostgreSQL startup, real project creation, real MP4 import, two rendered MP4 outputs, bundled FFprobe duration validation, crash recovery, persistence, three restart cycles, dynamic ports, one-cluster check, and no remaining new ContentOS/PostgreSQL processes |
| Final packaged manifest | CLEAN_WINDOWS_TESTED | Run #95 generated the current `runtime-manifest.json` for commit `038c7c5b7d7ce5b310b64d658eb666f1fe8219cc`, PostgreSQL 18.4, FFmpeg 6.1.1, FFprobe 4.0.2, and SHA256 values |
| Windows packaging CI | PASS | Run #95 (`36714930273`) passed Quality, Windows Runtime Startup V1, Database/tests, Build, Desktop Windows package/smoke, and Browser/render acceptance; artifact archive digest `sha256:0c130d6c2ae0c19bd57c2190e1bcf5693bcff21f6a97e5eddd58b333d704c275` |
| V1 acceptance status | V1_ACCEPTED | D0-D8 evidence complete on `feature/contentos-desktop-v1`; optional provider warnings remain non-blocking and are not required for the core desktop distribution gate |
| Remote branch | PUSHED | `git push origin feature/contentos-desktop-v1` succeeded; local HEAD and `origin/feature/contentos-desktop-v1` are `038c7c5b7d7ce5b310b64d658eb666f1fe8219cc` |

The final report must distinguish:

- `IMPLEMENTED`: source exists and review completed.
- `TESTED_ON_DEV_MACHINE`: automated or local smoke test passed.
- `PACKAGED`: a real installer/portable artifact was generated.
- `CLEAN_WINDOWS_TESTED`: artifact was tested on a clean Windows machine/profile.
- `V1_ACCEPTED`: all required gates and evidence are complete.

## Final Windows acceptance evidence

The final clean acceptance ran from the CI-produced installer with external database/media/provider variables removed and PATH restricted to Windows system directories. It generated a real 320x180 MP4 source, imported it through the product API, rendered two outputs through bundled FFmpeg, and validated the second output with bundled FFprobe (`2.000000` seconds). The same isolated user-data root survived a forced app crash and restart, and the final process check found no new ContentOS.exe or postgres.exe processes.

The CI artifact is `contentos-desktop-windows-038c7c5b7d7ce5b310b64d658eb666f1fe8219cc` with archive digest `sha256:0c130d6c2ae0c19bd57c2190e1bcf5693bcff21f6a97e5eddd58b333d704c275`.

## Known local limitation

The PostgreSQL 18.4 Windows binaries fail `initdb` when their executable/data paths are passed directly through the current Chinese workspace path. The manager uses Windows short paths where available; the packaged smoke was therefore run from an ASCII temporary install/user-data root. A clean-machine acceptance must explicitly include an install path and user profile representative of the release environment.
