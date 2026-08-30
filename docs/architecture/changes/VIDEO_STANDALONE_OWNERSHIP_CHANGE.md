# Video Standalone Ownership Change

## Current State

The accepted Video Quick Edit slice stores `edit_manifests` and `renders` with a mandatory `project_id`. Jobs and Assets have nullable database columns, but their public services and source-asset links are project-scoped. The existing Quick Edit behavior is therefore a Project Video Manifest Adjustment, not a standalone product.

## Problem

The product must support a genuine Standalone Quick Edit entry point that accepts video assets and a voice without creating a Content Project. Reusing a hidden or fake project would corrupt product semantics and make future ownership, retention and UI behavior ambiguous.

## User Requirement

Standalone Quick Edit must create a durable session, generate an immutable Edit Manifest revision from READY assets and real voice duration, apply shared adjustments, and enqueue the existing Exact Render Job handled by the existing Video Worker. Project Video must remain backward compatible.

## Options

1. Create a hidden Content Project for every standalone session — rejected because it violates the no-fake-project requirement.
2. Create a second standalone Job/Renderer/Manifest system — rejected because it duplicates durable execution and breaks shared invariants.
3. Add a Video Workspace ownership boundary with PROJECT and STANDALONE scopes — selected because it preserves old project columns while giving standalone records a first-class owner.

## Decision

Add `video_workspaces` (`PROJECT` or `STANDALONE`) and `video_workspace_assets`. Add nullable `workspace_id` columns to Jobs, Edit Manifests and Renders. Existing project rows are backfilled to a PROJECT workspace; their `project_id` remains populated and all existing project APIs continue to work. Standalone rows use `workspace_id` and a null `project_id`. The Edit Manifest contract accepts `projectId` for legacy/project records or `workspaceId` for standalone records.

The Job contract gains optional `workspaceId`; the Video Worker remains the single renderer/worker path and resolves ownership from either project or workspace scope. Asset content remains content-addressed and can be linked to either a project or standalone workspace, never both through the same workspace link.

## Migration

Migration 0016 creates workspaces, backfills one project workspace per existing project, adds nullable workspace columns and indexes, and adds standalone asset links. It is additive and can be rolled back before standalone data is created. A later migration may make workspace ownership mandatory after all callers migrate; this correction does not force that cutover.

## Compatibility

`/api/v1/projects/:projectId/video/quick-edits` remains as a deprecated compatibility alias to the canonical `/adjustments` route. `VideoQuickEditService` remains an export alias for `VideoAdjustmentService`. Existing `project_id` queries and project test fixtures remain valid.

## Rollback

Disable standalone routes, stop creating standalone workspaces, and run the down migration only after deleting standalone workspace rows and links. Existing project data continues using the legacy project columns.

## Risks

- Dual ownership columns can drift if a service writes mismatched project/workspace values; constraints and service scope helpers must reject mismatches.
- Legacy direct SQL fixtures may omit workspace IDs; project paths must continue to accept them during the compatibility period.
- Asset deduplication must not copy secret or private metadata between owners; only content-addressed storage is shared.
- A future mandatory workspace cutover requires a separate ADR and architecture review.
