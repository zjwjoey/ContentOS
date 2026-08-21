# ADR-009: Structured Cross-boundary Observability

**Status:** Accepted with Conditions

## Context

Async render/publish flows are difficult to diagnose without a traceable record across API, queue and workers.

## Decision

Adopt structured logs, durable Job events, correlation IDs and metrics/tracing-compatible propagation as baseline platform capabilities.

## Consequences

Every user-visible asynchronous action can be explained by an authorized status view. Sensitive prompts, cookies and tokens remain redacted; debugging evidence is intentionally bounded.
