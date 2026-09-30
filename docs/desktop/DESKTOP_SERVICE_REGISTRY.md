# Desktop Service Registry Mapping

Desktop does not duplicate service definitions. `apps/runtime-host/src/service-definitions.ts`
remains authoritative. The desktop diagnostics view groups those services as follows:

| Group | Services | Startup impact |
| --- | --- | --- |
| Core | migration, api, web, asset, director, video, review | Blocks `READY` |
| Optional | benchmark, digital-human, publisher | Warning / degraded readiness |
| External | PostgreSQL | Doctor + migration gate |

Each row displays the Runtime Host state, PID when available, port when applicable,
restart count, last error, and capability probe result. Service restart is delegated to
Runtime Client, which rejects restarts that would leave dependents against a changed
dependency.

## Extension interface

Future workers may register a `ServiceDefinition` through the Runtime Host registry.
They must provide an explicit dependency list, bounded startup/shutdown timeouts,
restart policy, and readiness signal. Desktop must not special-case individual worker
business logic; it renders the registry metadata.
