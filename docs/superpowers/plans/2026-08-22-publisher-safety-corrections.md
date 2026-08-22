# Publisher Safety Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Slice 5 adapters fail closed, preserve publishing intent durably and prevent review or profile-state bypasses.

**Architecture:** Keep platform behavior inside Publisher adapters and persistence inside the Publisher module. The Review module exposes an approval port; the Publisher Worker consumes that port without querying Review tables. PostgreSQL stores publisher state, while an unknown external side effect remains blocked until an approved reconciliation source confirms it.

**Tech Stack:** TypeScript, PostgreSQL migrations, Node test runner, Playwright ports and existing WorkerRuntime.

---

## Task 1: Record immutable publish intent and Review approval

**Files:** contracts Publisher/Review types, `packages/modules/review/src/review-service.ts`, `packages/modules/publisher/src/publisher-registry.ts`, Publisher/Review tests.

- [x] Write failing tests for snapshot-digest mismatch and file checksum mismatch.
- [x] Add a canonical digest helper and `assetSha256` to real publish snapshots.
- [x] Require PUBLISH review evidence to carry the digest and add a public Review approval port that validates the latest decision by ID and digest.
- [x] Make the Worker validate digest and local media SHA-256 before dispatch.

## Task 2: Persist publication state and block uncertain replays

**Files:** `migrations/0006_publisher_state.sql`, down migration, Publisher state-store module, adapters, integration tests.

- [x] Write failing tests showing a fresh adapter instance reads persisted published/unknown state.
- [x] Add the Publisher-owned state table and PostgreSQL state-store port.
- [x] Require a state store when composing real adapters; retain in-memory state for isolated tests only.
- [x] Persist unknown outcomes before returning and prevent a second create/submit attempt.

## Task 3: Correct platform and browser semantics

**Files:** Douyin adapter, WeChat adapter, browser port, adapter tests.

- [x] Write failing tests for documented create path, WebM MIME, upload network retryability, asynchronous success waiting and normalized pre/post-submit browser failures.
- [x] Correct the endpoint profile and failure mappings.
- [x] Wait for WeChat success; use opaque evidence references and no synthetic external post ID.
- [x] Verify only opaque evidence references leave the adapter.

## Task 4: Fail closed operationally

**Files:** `.gitignore`, worker main, smoke script, setup docs, tests.

- [x] Write failing tests for ignored local artifact roots, no-op entrypoint prevention and nonzero smoke failure exit.
- [x] Ignore profile/evidence roots, require explicit real Worker composition, and make smoke failures exit nonzero.
- [x] Update local setup and architecture decisions with the new safety boundary.

## Task 5: Verify and publish

- [x] Run focused tests after every task, then format, lint, typecheck, full tests, build, doctor and `git diff --check`.
- [x] Run a secret/artifact leakage scan and confirm no live platform operation occurred.
- [x] Commit corrections and push the existing feature branch; do not open or merge a PR unless requested.
