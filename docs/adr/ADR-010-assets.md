# ADR-010: Canonical Asset System

**Status:** Accepted with Conditions

## Context

Source, derivative and rendered media must be reusable, traceable and safe across workers.

## Decision

Use Asset as the canonical immutable media identity, `AssetDerivative` for derived artifacts and `ProjectAsset` for project-specific role links. Access storage through an adapter port.

## Consequences

Workers stage and validate files before promotion; temporary files never become source of truth. V1 can use local storage and later adopt S3-compatible storage without changing media references.
