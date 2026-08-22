# ADR-005: Browser-based Publishing Behind Adapters

**Status:** Accepted with Conditions

## Context

Target platforms may lack stable publishing APIs or require interactive browser flows.

## Decision

Run Playwright only in the Publisher Worker and hide platform-specific behavior behind Publisher adapters.

## Consequences

Browser profiles/credentials are isolated outside tracked source state and failure diagnostics expose only opaque evidence references. Uncertain outcomes are durably blocked for reconciliation rather than blindly reposted. A later API-backed adapter can replace browser automation without changing Publisher commands.
