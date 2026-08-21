# ContentOS

ContentOS is in Engineering Initialization. The current implementation target is the first `Project → Asset → Job → Video` vertical slice defined by Architecture V0.

## Commands

```powershell
pnpm install
pnpm run format
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
pnpm run doctor
```

Do not commit `.env`, credentials, cookies, generated media, `node_modules`, temporary storage or local PostgreSQL data. See [AGENTS.md](AGENTS.md) and [docs/ENGINEERING_INITIALIZATION_PLAN.md](docs/ENGINEERING_INITIALIZATION_PLAN.md).
