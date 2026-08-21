# ContentOS Engineering Rules

These rules apply after Architecture V0 Freeze.

- Keep the modular-monolith module boundaries and published application contracts.
- Do not cross-read or cross-write another module's private tables.
- Long-running work travels through durable Jobs; request handlers do not run FFmpeg, browsers or AI generation.
- Renderer code executes an immutable, validated `EDIT_MANIFEST_V0`; it never invents creative choices.
- Platform-specific behavior stays in Publisher Adapters inside the Publisher Worker.
- AI vendor SDKs stay behind the AI Provider contract.
- PostgreSQL is business truth; queue rows are delivery state only.
- Lease recovery, idempotency, cancellation and external-state reconciliation are required paths, not optional polish.
- Secrets, cookies, authorization headers, API keys, access/refresh tokens and browser session state never enter ordinary logs or Job payloads.
- `research/` and `spikes/` are historical/evidence directories and are not runtime dependencies.
- Avoid premature generic workflow engines, shared utility dumping grounds and speculative abstractions.
- Every core record and asynchronous event carries the relevant project/job/attempt/correlation identifiers.
- A boundary or invariant change requires evidence, an ADR update and architecture review.
