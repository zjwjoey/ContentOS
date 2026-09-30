# Desktop V1 Acceptance Matrix

| Capability | Status | Evidence |
| --- | --- | --- |
| Isolated branch/worktree | IMPLEMENTED | `feature/contentos-desktop-v1` |
| Runtime Host reuse | IMPLEMENTED | `docs/runtime-startup-v1.md` and runtime packages |
| Secure Electron shell | IMPLEMENTED | `apps/desktop/src/main/main.ts`, `preload.ts` |
| Runtime Manager UI/API | IMPLEMENTED | `apps/desktop/src/main/runtime-manager.ts`, Desktop API contract |
| User-data/PostgreSQL layout | DESIGNED | `DESKTOP_DATA_LAYOUT.md` |
| Development launch | IMPLEMENTED | `pnpm desktop:dev` |
| TypeScript build | TESTED_ON_DEV_MACHINE | `pnpm desktop:build` |
| Windows installer | PACKAGED | `artifacts/desktop/ContentOS 0.1.0 x64.exe` |
| Windows portable executable | PACKAGED | `artifacts/desktop/ContentOS.exe` |
| Packaged runtime smoke | TESTED_ON_DEV_MACHINE | Runtime `READY_WITH_WARNINGS`; all services READY in `desktop-smoke-runtime-v4` |
| Clean Windows acceptance | NOT TESTED | Requires a clean Windows profile/machine |

The final report must distinguish:

- `IMPLEMENTED`: source exists and review completed.
- `TESTED_ON_DEV_MACHINE`: automated or local smoke test passed.
- `PACKAGED`: a real installer/portable artifact was generated.
- `CLEAN_WINDOWS_TESTED`: artifact was tested on a clean Windows machine/profile.
- `V1_ACCEPTED`: all required gates and evidence are complete.
