# ADR-007: Provider-neutral AI Layer

**Status:** Accepted

## Context

Creative capabilities will use evolving AI models and providers without allowing vendor SDKs to leak into content modules.

## Decision

Provide AI through a ModelRegistry, versioned prompts and capability-based provider adapters (`supports`, text, structured, stream).

## Consequences

Director records accepted output and provenance while providers remain replaceable. Structured output must validate against a caller schema. Credentials are indirect references.
