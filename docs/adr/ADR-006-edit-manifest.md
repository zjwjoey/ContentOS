# ADR-006: Immutable Declarative Edit Manifest

**Status:** Accepted

## Context

Creative planning must be reproducible and safely handed to a deterministic renderer.

## Decision

Use versioned, immutable `EDIT_MANIFEST_V0` records containing explicit sources, timing, operations and output requirements.

## Consequences

Renderer behavior is constrained to declared operations and compatibility. Changes create a revision; incompatible operations fail clearly. Commands, UI timeline state and FFmpeg arguments are not the persistence contract.
