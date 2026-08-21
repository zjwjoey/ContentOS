# Spike 01: PostgreSQL + pg-boss + Job Worker

Disposable validation code for ContentOS Architecture V0. This is not a product module.

## Prerequisites

- Windows 10/11
- Node.js 22+ (validated with Node 24.14.0)
- PostgreSQL 13+ (validated with PostgreSQL 16.15)

The test defaults to `postgres://postgres@127.0.0.1:55432/contentos_spike`. Set `DATABASE_URL` to another disposable database when needed.

## Run

```powershell
npm install
$env:DATABASE_URL = 'postgres://postgres@127.0.0.1:55432/contentos_spike'
npm test
```

The test suite covers normal progress, retry history, terminal failure, cooperative cancellation, duplicate delivery/idempotency and an actual child-process kill followed by lease recovery.

The suite creates only `spike01` tables and a `spike01_queue` pg-boss schema. Test setup drops that queue schema and truncates the Spike tables; it does not touch formal ContentOS schemas.
