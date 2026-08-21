# Project Structure V0

## Recommended repository layout

```text
ContentOS/
  apps/
    web/                    # Next.js/React interface
    api/                    # Fastify HTTP control plane
    worker-video/           # Video Worker composition root
    worker-publisher/       # Publisher Worker composition root
  packages/
    contracts/              # API, event and manifest schemas
    modules/
      project/ director/ asset/ video/ publisher/ review/ job/ ai/
    platform/               # config, auth, observability, shared ports
    infrastructure/
      postgres/ storage/ queue/ ffmpeg/ playwright/ providers/
  docs/
    architecture/ data/ modules/ contracts/ adr/ review/
  tests/
    fixtures/ contract/ integration/ e2e/
  research/                  # historical research only; not a runtime dependency
  spikes/                    # disposable validation only; not a runtime dependency
  AGENTS.md
```

This is a design target, not a request to scaffold it now. An app is a composition root and may depend on module public application ports. A module may not reach into a sibling module's internals; infrastructure adapters depend inward on contracts and ports.

## V0 technology recommendation

| Concern | Recommendation | Status |
|---|---|---|
| Language/runtime | TypeScript on Node.js 22 LTS | recommended |
| Workspace | pnpm workspaces | recommended |
| Web | Next.js + React | recommended |
| API | Fastify + Zod validation | recommended |
| Persistence | PostgreSQL 16 + Drizzle migrations/query layer | provisional spike |
| Durable jobs | pg-boss over PostgreSQL | provisional spike |
| Rendering | FFmpeg behind Video Worker | accepted |
| Browser publishing | Playwright behind Publisher Worker | accepted |
| Storage | local adapter first; S3-compatible adapter later | accepted boundary |
| Logs/traces | Pino + OpenTelemetry-compatible propagation | recommended |

The initialization spike must validate Windows process supervision, PostgreSQL/pg-boss semantics, local storage atomic promotion, FFmpeg packaging and Playwright profile isolation before these provisional choices become implementation commitments.
