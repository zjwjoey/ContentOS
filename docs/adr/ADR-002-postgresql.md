# ADR-002: PostgreSQL as System of Record

**Status:** Accepted

## Context

Projects, revisions, jobs, auditability and publishing outcomes require durable relational facts.

## Decision

Use PostgreSQL as the system of record for domain state, Job state, event/audit records and dynamic configuration.

## Consequences

Database transactions protect intent and state transitions. JSONB may hold versioned payloads but does not replace ownership, indexes or constraints. The queue/cache cannot become the only record of business truth.
