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

## Hardening contract

`contentos up` is a client-orchestrated lifecycle operation. It does not return after merely
opening the control port: it validates `/runtime/identity`, waits for the aggregate state to be
`READY` or `READY_WITH_WARNINGS`, and reports `FAILED`/timeout with service state and the log
root. A control port occupied by a non-ContentOS process is a conflict, not a running instance.
Stale state/locks are cleaned only after the recorded host PID is no longer alive; concurrent
starts are serialized by the atomic runtime lock.

The client owns restart: it stops the old host, waits for its PID and service ports to disappear,
then starts a fresh host and verifies a new identity. A service restart is rejected when it would
leave dependents running against a changed dependency. On Windows, `ProcessManager` uses
`taskkill /T /F` for the complete process tree and waits for actual exit.

`CONTENTOS_RUNTIME_MODE=DEVELOPMENT` launches source runners through `tsx`; `PACKAGED` launches
compiled entries and does not require `pnpm`. Runtime configuration (roots, database URL and all
ports) is resolved once and propagated to every child. Optional services may be degraded without
blocking readiness; required services must be healthy and ready. Worker readiness is emitted as a
`{"status":"READY"}` stdout marker and health failures are bounded by the Supervisor budget.

The runtime gate is covered by `pnpm test:runtime` and `pnpm test:runtime:integration`; CI also
runs the same gate on `windows-latest`.
