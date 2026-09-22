# ContentOS Runtime Startup V1

Runtime Startup V1 provides one lifecycle boundary for local development and desktop launch.

## Commands

```bash
pnpm contentos up
pnpm contentos up --safe
pnpm contentos status
pnpm contentos services
pnpm contentos doctor
pnpm contentos logs [serviceId]
pnpm contentos restart
pnpm contentos restart-service api
pnpm contentos down
```

The CLI is independent of the web UI and talks to a localhost-only Runtime Host. Mutating
control calls use the token stored in `runtime/state/runtime.json`; the host binds only to
`127.0.0.1`. Runtime state, per-service logs, and startup reports are written below
`CONTENTOS_RUNTIME_ROOT` (default `runtime/`).

## Startup boundary

The host acquires a single-instance lock, runs core/optional Doctor checks, verifies the
database, runs migrations, then starts API, workers, and Web in dependency order. Optional
workers (Digital Human, Benchmark, Publisher) produce warnings and do not block core startup.
`--safe` starts only required services. Each transient process has a bounded restart budget
(three attempts per 60 seconds with backoff); graceful shutdown sends SIGINT before force stop.

The startup report records the resolved app root, app version/commit when supplied, migration
result, per-service startup time, service readiness, total startup time, Doctor findings, and
warnings. The runtime never derives its app root from the shell's current directory unless
explicitly configured with `CONTENTOS_APP_ROOT`.
