# ContentOS

ContentOS is a local-first content production and matrix operations console. The current product path is `Project Center → Assets → Director → Video → Approval → Fake Publisher`; Standalone Quick Edit remains available, while Review analytics and live platform adapters are deferred.

## Commands

```powershell
pnpm install
pnpm run format
pnpm run lint
pnpm run security:scan
pnpm run typecheck
pnpm test
pnpm test:inventory
pnpm run build
pnpm run doctor
```

Project Video uses `STORYBOARD_V1` when an approved Director pair is present. Operators bind one or more READY project video assets to every Storyboard scene before generating a plan. Standalone Quick Edit continues to use deterministic `RANDOM_MONTAGE` planning.

Do not commit `.env`, credentials, cookies, generated media, `node_modules`, temporary storage or local PostgreSQL data. See [AGENTS.md](AGENTS.md) and [docs/ENGINEERING_INITIALIZATION_PLAN.md](docs/ENGINEERING_INITIALIZATION_PLAN.md).
