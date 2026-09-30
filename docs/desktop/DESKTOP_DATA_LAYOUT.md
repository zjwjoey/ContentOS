# Desktop Data Layout

The install directory is immutable application content. Runtime and user data are
resolved from the OS user-data directory in packaged mode and from the repository
runtime directory in development mode.

```text
<userData>/ContentOS/
  config/                 user-editable desktop configuration
  runtime/
    state/                runtime.json and atomic lock
    logs/                 runtime-host and service logs
    startup-reports/      one JSON report per startup
  storage/local/          local media and generated artifacts
  postgres-data/          reserved PostgreSQL data directory (never in install dir)
  updates/                staged update metadata and packages
```

The Desktop path provider passes `CONTENTOS_APP_ROOT`, `CONTENTOS_RUNTIME_ROOT`,
`CONTENTOS_CONFIG_ROOT`, `STORAGE_ROOT`, and `CONTENTOS_POSTGRES_DATA_ROOT` to the
Runtime Host. Secrets such as `DATABASE_URL` are read from configuration and never
written to logs, IPC snapshots, or renderer state.

## Development vs packaged

- Development defaults to the existing repository `runtime/` and `storage/local/`.
- Packaged mode defaults to Electron `app.getPath('userData')` and keeps all mutable
  state outside `resources/` and the installation folder.
- A migration or startup failure reports the resolved paths so support can diagnose
  permissions and disk issues without exposing credentials.
