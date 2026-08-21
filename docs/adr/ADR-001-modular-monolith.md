# ADR-001: Modular Monolith

**Status:** Accepted

## Context

ContentOS V1 needs coherent transactional project work while the product surface is still evolving.

## Decision

Build one modular control-plane deployment with strict internal module boundaries. Use independently started Video and Publisher Workers for execution.

## Consequences

Cross-module calls remain in-process application contracts initially, so transactions and debugging are simpler. Modules must still be independently testable and may not share private persistence access. Microservices are deferred until scaling/ownership evidence warrants them.
