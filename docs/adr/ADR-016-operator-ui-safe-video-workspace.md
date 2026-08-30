# ADR-016: Operator UI Safe Video Workspace Boundary

**Status:** Accepted with Conditions

## Context

Operator UI V1 needs native media previews and iterative standalone Manifest editing without exposing storage paths or requiring operators to enter internal identifiers. The Web layer must remain a contract client while standalone sessions retain one authoritative current Manifest.

## Decision

- Standalone media delivery is exposed only through a workspace-scoped API route that validates the session, workspace membership and READY lifecycle before streaming through the storage provider.
- Manifest adjustments advance the standalone session's `current_manifest_id`; the immutable revision remains owned by the Video module.
- The UI may select a primary READY voice Asset and a replacement READY video Asset, but it never writes Video or Asset private tables directly.

## Evidence and Conditions

The consecutive-adjustment integration test, Inspector operation tests, two isolated Playwright scenarios, typecheck, full suite, migration matrix, and Web build provide implementation evidence. HTTP range support and live platform adapters remain outside this decision and require separate review before expansion.
