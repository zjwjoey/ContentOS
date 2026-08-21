# ADR-004: Direct FFmpeg Rendering for V1

**Status:** Accepted with Conditions

## Context

V1 needs predictable short-video rendering without a second UI/rendering runtime.

## Decision

Use FFmpeg in the Video Worker behind a thin internal command builder driven by immutable Edit Manifests.

## Consequences

The initial capability set is deliberately narrow and testable. Remotion/template preview is deferred behind a future renderer port. Workers validate outputs before Asset promotion.
