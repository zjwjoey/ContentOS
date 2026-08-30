# ContentOS Operator UI V1

## Purpose

Operator UI V1 turns the existing ContentOS engineering pages into a continuous desktop operator workspace. It is an operational surface over the frozen modular-monolith contracts, not a new editing engine.

## Hierarchy

Global navigation contains 项目中心 and 快速剪辑. Project navigation contains Overview, Assets, Director, Video, Approval, and Publisher. Review Analytics is deferred and is intentionally absent from navigation.

## Global shell

The product uses a persistent left navigation, dark neutral workbench styling, shared page headers, status badges, and explicit loading/empty/error states. The shell is independent of project context and works on both the home page and standalone Quick Edit.

## Standalone Quick Edit

Quick Edit begins with a real draft session. The approved layout is a three-column workspace:

1. Asset library for video and primary voice uploads, import states, and native previews.
2. Center preview and Manifest timeline with revision history.
3. Selected-clip Inspector for TRIM, REMOVE, REORDER, REPLACE, and REROLL.

The browser emits `QuickEditOperation`; the Video module owns adjustment semantics. Render remains a durable Job and the resulting output is previewed as a playable video when READY.

## Project workflow

Overview exposes real project health, stage, actions, and Jobs. Assets exposes upload/import/preview. Director shows Brief, complete Script metadata, and Storyboard scenes. Video reuses the standalone timeline and exact-render concepts. Approval is an exact-revision queue with inline rejection reasons. Publisher remains Fake Platform only and presents state-aware next actions.

## Status model

Web uses one status mapping source for user labels, semantic tone, and coarse group while retaining raw domain values in details. No page invents dashboard counts or status meanings.

## Boundaries and non-goals

PostgreSQL remains business truth and durable Jobs remain the path for long-running work. Browser/API code never exposes storage keys, credentials, cookies, or staged paths. V1 does not add Review Analytics, real platform publishing, AI Vision, Storyboard Planner expansion, semantic matching, voice alignment, Canvas/WebGL, FFmpeg WASM, waveform rendering, drag-drop frameworks, or a new database migration.
