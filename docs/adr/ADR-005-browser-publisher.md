# ADR-005: Browser-based Publishing Behind Adapters

**Status:** Accepted with Conditions

## Context

Target platforms may lack stable publishing APIs or require interactive browser flows.

## Decision

Run Playwright only in the Publisher Worker and hide platform-specific behavior behind Publisher adapters.

## Consequences

Browser profiles/credentials are isolated and failure diagnostics are redacted. Uncertain outcomes trigger reconciliation rather than blind reposting. A later API-backed adapter can replace browser automation without changing Publisher commands.

## Integration Closure conditions

The real-adapter registry is disabled by default. Douyin HTTP and WeChat Channels Playwright adapters are composed only in the Publisher Worker after asset checksum, account and credential checks. WeChat defaults to headed mode with irreversible submit disabled. **IMPLEMENTED != LIVE-VERIFIED**; Stage 1 performs no live login or platform submission.
