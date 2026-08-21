# ADR-003: Durable Job Queue with PostgreSQL Truth

**Status:** Accepted with Conditions

## Context

Rendering and publishing are slow, failure-prone and must survive process restarts.

## Decision

Model work as persistent Jobs with attempts, events, leases, retries and idempotency. Use a queue adapter for delivery; evaluate pg-boss first in the initialization spike.

## Consequences

Handlers are at-least-once safe and recover expired leases. The spike may choose another adapter only if it preserves the Job contract and database truth; such a replacement requires an ADR update.
