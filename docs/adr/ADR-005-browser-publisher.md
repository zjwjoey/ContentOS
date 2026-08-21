# ADR-005: Browser-based Publishing Behind Adapters

**Status:** Accepted with Conditions

## Context

Target platforms may lack stable publishing APIs or require interactive browser flows.

## Decision

Run Playwright only in the Publisher Worker and hide platform-specific behavior behind Publisher adapters.

## Consequences

Browser profiles/credentials are isolated and failure diagnostics are redacted. Uncertain outcomes trigger reconciliation rather than blind reposting. A later API-backed adapter can replace browser automation without changing Publisher commands.
