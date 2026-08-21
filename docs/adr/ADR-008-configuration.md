# ADR-008: Layered Configuration and Secret References

**Status:** Accepted

## Context

Workers require environment-specific infrastructure settings and credentials without exposing sensitive values.

## Decision

Separate boot configuration, dynamic audited configuration, project policy and opaque credential references. Enforce startup validation and redaction.

## Consequences

Runtime behavior is explainable by non-secret configuration versions. Secret rotation avoids historical rewrites. Optional integrations can be disabled explicitly rather than fail open.
