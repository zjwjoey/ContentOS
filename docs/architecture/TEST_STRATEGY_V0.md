# Test Strategy V0

## Testing pyramid

| Layer | Purpose | Essential examples |
|---|---|---|
| Architecture/contract | protect module boundaries and schemas | forbidden imports, API/error envelopes, Manifest conformance |
| Domain unit | deterministic state and policy rules | project transitions, idempotency, review gates, retry classification |
| Adapter integration | validate real infrastructure behavior | PostgreSQL transactions, pg-boss lease recovery, storage promotion |
| Worker fixture | exercise bounded media/browser contracts | FFmpeg fixture render, Playwright adapter sandbox/mocks |
| End-to-end | prove a thin happy path | project -> approved manifest -> render -> controlled publish simulation |

## Rules

1. Every module command has success, invalid-state and idempotent-replay coverage.
2. `EDIT_MANIFEST_V0` has valid, invalid and unsupported-operation fixtures; renderer output metadata is asserted deterministically.
3. Job tests cover retry, cancellation, worker crash/lease expiry and downstream dependency blocking.
4. Publisher tests default to a simulated adapter or platform sandbox; a real account is never a CI prerequisite.
5. Migrations are exercised against a fresh PostgreSQL database and upgrade fixtures before release.
6. Tests create their own asset roots, browser profiles and database schema; no developer state is reused.
7. Contract changes require producer and consumer conformance tests before a new version is accepted.

## Quality gates

Before a V1 increment merges, run formatting/type checks, unit/contract tests, database integration tests, worker fixture tests, dependency-boundary checks and a redaction scan. Real FFmpeg and browser smoke tests run in a controlled environment with versioned tool binaries; their result is reported separately from ordinary unit tests.
