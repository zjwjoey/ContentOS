# ContentOS V1 Integration Acceptance

状态：`LOCAL_VALIDATED`（未宣称 `INTEGRATION ACCEPTED`）

日期：2026-10-01

## 已验证

| Gate | Result | Evidence |
| --- | --- | --- |
| TypeScript | PASS | `pnpm typecheck` |
| Source build | PASS | `pnpm build` |
| Format and lint | PASS | `pnpm format`, `pnpm lint` |
| Runtime contracts | PASS | `pnpm test:runtime` — 23/23 |
| Migration matrix | PASS | `pnpm test:migrations` — 10/10, including legacy Desktop `0047` history upgrade |
| Intelligent Editing V1.5 | PASS | `CONTENTOS_TEST_DATABASE_URL=… pnpm test:intelligent-editing-v15` — 28/28 |
| Web production build | PASS | `pnpm --dir apps/web build` |
| Windows package | PASS | `pnpm desktop:package`; installer and portable artifacts generated |
| Portable packaged smoke | PASS | `pnpm desktop:smoke`; API, Web, Embedded PostgreSQL, migrations and `media-intelligence-worker` were `READY` |
| Installer smoke | PASS | `pnpm desktop:installer-smoke`; silent install, launch, stop and uninstall completed |

The packaged smoke explicitly verifies that `media-intelligence-worker` is
registered as an optional service and reaches `READY`. Its worker log reports
the `MEDIA_ANALYSIS` handler.

## Not yet accepted

- The clean-Windows acceptance scenario that imports media, performs an actual
  render, restarts repeatedly and checks persistence has not been run in this
  integration worktree.
- Remote fetch/push and GitHub Actions evidence cannot be produced while this
  environment cannot connect to GitHub. The integration branch must be pushed
  and its CI run must pass before it is marked `INTEGRATION ACCEPTED`.

## Scope confirmation

- Forward migrations are `0001`–`0046` plus Intelligent Editing `0047`–`0052`.
- Desktop Digital Human duration migration `0047_digital_human_duration.sql`
  is not a forward migration; only its down compatibility file is retained for
  existing Desktop V1 history.
- Packaged normal mode defaults Intelligence to real/unconfigured providers;
  Fake Intelligence is available only in explicit test mode.
