# OPERATOR UI GAP AUDIT

Date: 2026-08-30
Baseline: `origin/main@fbf7dadf189355bf55d7b937c08226029556c26c`
Branch: `codex/operator-ui-v1`

## SUPPORTED

- Project Center reads the real snapshot API and renders stage cards, health, actions and recent Jobs.
- Project-scoped API routes exist for Assets, Director, Video, Approval and Publisher.
- Asset upload/import polling and READY Video/Audio previews exist for Project Assets.
- Director Brief creation, Script/Storyboard durable Jobs, revisions and approval actions exist.
- Project Video can create render Jobs, render and select Manifest revisions, create Video Adjustment versions and submit Render Approval.
- Approval Gate can list and approve/reject exact target revisions.
- Fake Publisher can create accounts, hand off requests, queue approved revisions and show attempts/ExternalPost outcomes.
- Standalone Quick Edit can create a no-project session, upload files, generate a plan and queue exact rendering.
- Existing backend contracts already own the five adjustment operations: TRIM, REMOVE, REORDER, REPLACE and REROLL.

## PARTIAL

- `RootLayout` is only `<html><body>{children}</body></html>`; there is no global OperatorShell.
- Homepage supports real project create/list and Quick Edit entry, but has no Dashboard Header, sidebar or action grouping.
- `ProjectNav` exists and is reusable in source, but each page still repeats its own headers and links; no nested Project Workspace layout exists.
- Status labels are duplicated in page files; there is no single UI status mapping for label, tone and group.
- Project Assets supports upload/import polling and media playback, but the UI accepts one file per input event and has no asset grid/filter/selected preview state.
- Director has real Brief/Script/Storyboard data, but the UI shows a long form and condensed text instead of a split content workbench with full Script and Scene fields.
- Project Video has real render/Manifest/adjustment actions, but the timeline is a text list with inline buttons and no selected-clip Inspector or shared video components.
- Approval Gate is real but rejection uses `window.prompt()` and has no queue-oriented grouping/status treatment.
- Publisher is real and Fake-only, but account/request/attempt data is presented as a dense log rather than action-oriented sections.
- Standalone Quick Edit exposes the correct API calls, but requires manual Asset IDs, has no workspace asset browser/content preview, no voice selection display, no visual timeline, no selected-clip Inspector and no adjustment controls.

## MISSING

- Global OperatorShell with sidebar, topbar, page header, status badge, empty/loading/error primitives.
- Nested Project Workspace shell that owns one consistent Overview → Assets → Director → Video → Approval → Publisher navigation.
- Shared `status.ts` mapping and reusable `StatusBadge`/`JobStatus` components.
- Standalone workspace asset content endpoint and safe workspace ownership read path, if the current API audit confirms it is still absent.
- Standalone session settings/voice selection update path, if the current service audit confirms creation-time-only settings are insufficient.
- Shared visual media, timeline, clip card, clip inspector, manifest history and asset picker components.
- Product-level standalone TRIM, REMOVE, REORDER, REPLACE and REROLL interaction that only emits `QuickEditOperation` payloads.
- Standalone render polling and playable output feedback loop.
- Browser acceptance for Global Shell, Standalone Quick Edit and Project Flow visualization.

## Constraints Confirmed

- Review Analytics remains Deferred and no fake Review page will be created.
- No new migration is currently required; existing `0001`–`0018` data is sufficient for the UI plan.
- Web must use public API/service contracts and never read database tables, storage keys, absolute paths or credentials.
- Real Douyin/WeChat publishing remains disabled; Fake Publisher is the only automated UI acceptance path.
