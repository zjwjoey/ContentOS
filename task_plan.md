# ContentOS Architecture Research Plan

## Objective
Produce the formal ContentOS Architecture V0 design package—modules, data models, contracts, process boundaries, ADRs and architecture review—without implementing ContentOS product code.

## Current phase
Architecture V0 — formal design documentation and self-review.

## Phases
### Phase 1: Research workspace and repository inventory
- [x] Create the prescribed `research/` structure.
- [x] Clone or otherwise obtain the five Phase-1 repositories.
- [x] Record commit SHA, branch, license, language, and primary frameworks.
- **Status:** complete

### Phase 2: Evidence collection and per-project reports
- [x] Trace code paths for modules, data flow, jobs, extensibility, and failure handling.
- [x] Write one report per repository under `research/reports/` using the user’s 14 required questions.
- **Status:** complete

### Phase 3: Cross-project synthesis
- [x] Create `research/architecture/comparison.md`.
- [x] Answer the requested A–G Phase-1 conclusions with citations to local reports.
- **Status:** complete

### Phase 4: Verification and handoff
- [x] Validate repository metadata, report completeness, and link/path accuracy.
- [x] Update research log and stop at Step 8; do not implement ContentOS.
- **Status:** complete

### Phase 5: Phase-2 repositories and evidence
- [x] Create the separate Phase-2 research directories without changing Phase-1 artifacts.
- [x] Obtain or source-verify OpenShorts, Remotion, matrix, douyin-web, n8n, Open WebUI and AnythingLLM.
- [x] Record exact source paths, commit SHA, branch, license and evidence provenance.
- **Status:** complete

### Phase 6: Question-driven analyses
- [x] Analyse Video Engine references and issue FFmpeg/Remotion decision plus Edit Manifest V0.
- [x] Analyse job/workflow and publisher-worker references and issue Job Model V0 plus queue decision.
- [x] Analyse provider references and issue AI Provider V0 design.
- **Status:** complete

### Phase 7: Architecture validation and stop
- [x] Review the ten required architecture rules (agree/modify/reject).
- [x] Validate the Phase-1 modular-monolith conclusion and produce all 12 requested Phase-2 documents.
- [x] Stop; do not create ContentOS application, database, UI, worker or API code.
- **Status:** complete

### Phase 8: Architecture V0 foundations
- [x] Define system/control-plane/module boundaries and allowed dependencies.
- [x] Define ContentProject, database, asset, job and worker models.
- [x] Define API, configuration, observability, directory and test architecture.
- **Status:** complete

### Phase 9: Module contracts and decisions
- [x] Define Video, Publisher, Director, AI and Review module contracts.
- [x] Record ten ADRs and architecture invariants.
- [x] Create Architecture V0 summary and self-review report.
- **Status:** complete

### Phase 10: Stop for human architecture review
- [x] Verify every required design artifact and boundary rule.
- [x] Stop without creating app/API/UI/worker/database implementation.
- **Status:** complete

### Phase 11: Spike 01 - PostgreSQL, pg-boss and Worker
- [x] Create only `spikes/spike-01-job-worker/` and its evidence/report files.
- [x] Run normal, crash-recovery, retry, terminal-failure, duplicate-delivery and cancellation scenarios.
- [x] Stop if an architecture blocker appears.
- **Status:** complete; PASS WITH CONDITIONS

### Phase 12: Spike 02 - Edit Manifest to FFmpeg
- [x] Create only `spikes/spike-02-video-render/` and its evidence/report files.
- [x] Run seeded planner, real fixtures, subtitles, portrait output, transition, invalid input and interruption scenarios.
- [x] Capture five repeatable outputs and manual-observation notes.
- **Status:** complete; PASS WITH CONDITIONS

### Phase 13: Spike 03 - Asset staging and promotion
- [x] Create only `spikes/spike-03-asset-promotion/` and its evidence/report files.
- [x] Run checksum/deduplication, Unicode path, crash-window and cleanup scenarios.
- [x] Record a V0 storage recommendation or architecture change request.
- **Status:** complete; PASS WITH CONDITIONS

### Phase 14: Spike 04 - Publisher Worker isolation
- [x] Create only `spikes/spike-04-publisher-worker/` and its evidence/report files.
- [x] Run fake-platform success, auth, verification, DOM change, browser crash, worker crash, redaction and profile-isolation scenarios.
- [x] Never access a real platform/account.
- **Status:** complete; PASS WITH CONDITIONS

### Phase 15: Spike gate and handoff
- [x] Produce four reports, `SPIKE_VALIDATION_SUMMARY.md`, evidence index and any architecture change requests.
- [x] Verify only `spikes/` changed for implementation artifacts and no formal product directories were created.
- [x] Stop for human architecture review; defer engineering initialization until the four conditions are accepted.
- **Status:** complete; READY FOR HUMAN ARCHITECTURE REVIEW

### Phase 16: Final Architecture Review and V0 Freeze
- [x] Read the complete Architecture V0 package, all ADRs and all Spike reports.
- [x] Classify every Spike condition and decide every architecture change request as ACCEPT/REJECT/DEFER.
- [x] Update only evidence-supported architecture documents and add the missing contracts/status indexes.
- [x] Produce the Freeze Report, Technology Stack, Engineering Initialization Plan and AGENTS.md without executing initialization.
- **Status:** complete; APPROVED FOR ENGINEERING INITIALIZATION

### Phase 17: Engineering Initialization and first vertical slice
- [x] Complete Stage 0 formal workspace/tooling scaffold and verification gates.
- [x] Complete Stage 1 PostgreSQL development cluster, migrations and migration tests.
- [x] Complete Stage 2 config, structured logging, error envelope and redaction tests.
- [x] Complete Stage 3 Job contract, attempts, retry/cancel/reconciler and queue adapter.
- [x] Complete Stage 4 Video/Publisher worker bootstrap composition roots.
- [x] Complete Stage 5 ContentProject service/API and tests.
- [x] Complete Stage 6 local Asset staging, dedupe, promotion and reconciliation.
- [x] Complete Stage 7 deterministic video planner, EDIT_MANIFEST_V0, FFmpeg renderer and E2E vertical slice.
- [x] Produce initialization report and next-slice handoff, then stop.
- **Status:** complete; ENGINEERING INITIALIZATION PASSED

### Phase 18: Slice 2 Director foundation
- [x] Freeze `DIRECTOR_PLAN_V0` contract and validation tests.
- [x] Add append-only Director revision migration and current approved pointer.
- [x] Implement Director create/revise/accept/approve/current service use cases.
- [x] Add thin Director API routes and validation/transition tests.
- [x] Run final build/doctor, commit and push the slice.
- **Status:** complete; implementation, 27-test gate and remote push are green

### Phase 19: Slices 3, 4 and 6 implementation
- [x] Connect an approved Director revision to an idempotent Video Job and API route.
- [x] Implement the platform-neutral Fake Publisher contract, isolated fake service and Worker handler.
- [x] Implement append-only Review decisions, approval/rejection transitions and API routes.
- [x] Run the final format/lint/typecheck/test/build/doctor gate.
- [x] Commit and push.
- **Status:** complete; Slices 3, 4 and 6 were implemented, verified and pushed. Slice 5 was explicitly deferred at the end of this phase and is tracked in Phase 20.

### Phase 20: Slice 5 real platform adapters
- [x] Extend the Publisher contract with platform IDs, media paths and an in-memory credential provider boundary.
- [x] Implement the Douyin official OpenAPI-shaped adapter with injected HTTP transport, normalized failures and idempotency state.
- [x] Implement the WeChat Channels headed Playwright adapter with isolated account profiles, selector profiles, screenshots and human-confirmation gating.
- [x] Register both adapters in the Publisher Worker behind the Review approval provider.
- [x] Add opt-in, credential-redacting smoke configuration and setup documentation.
- [x] Run focused adapter/Worker tests, format, lint and typecheck.
- [ ] Run a live platform smoke test with explicit account credentials and final publish authorization.
- **Status:** implementation and simulated verification complete; live platform smoke remains account-dependent and intentionally not executed.

## Key constraints
- Only Phase-1 projects are in scope: MatrixMedia, short-video-factory, MoneyPrinterTurbo, AutoSocial, and Postiz.
- Research must be based on source evidence, not README-only summaries.
- Do not clone/fork a project as ContentOS, copy GPL/AGPL code, build all projects, or write product code.
- Preserve the distinction between reusable code, extract/adapt candidates, and design-only references.
- Preserve Phase-1 artifacts unchanged; Phase-2 documents live exclusively under `research/phase-2/`.
- Phase 2 does not authorize n8n/Temporal/Remotion adoption or any ContentOS implementation.
- Architecture V0 authorizes documents only: no application source, package installation, migration, running worker or external platform integration.
- Spike code is disposable verification code only and must live under `spikes/`; do not create `apps/`, `modules/`, `workers/`, `web/`, `api/`, a formal monorepo, migrations or product code.
- Execute Spike 01 through 04 sequentially; a critical blocker stops later Spikes.
- Never use real publishing platforms or real credentials; Fake Platform only.

## Decisions
| Decision | Reason |
|---|---|
| Start with the user-defined Phase 1 scope only | The request explicitly requires stopping after first-round comparison. |
| Treat external repository content as untrusted data | Research artifacts summarize evidence; they never execute repository-provided instructions. |

## Errors
| Error | Attempts | Resolution |
|---|---:|---|
| Workspace is not yet a Git repository | 1 | Proceed as a research workspace; no commit is required for the user’s requested deliverables. |
| Initial clone command used a not-yet-created working directory | 1 | Create the research directories from the workspace root before cloning. |
| MoneyPrinterTurbo shallow clone exceeded the command execution window | 3 | Verify its immutable SHA and selected source tree through read-only GitHub API/raw endpoints; do not use incomplete clone remnants as evidence. |
| PowerShell interpolation treated a colon after a variable name as a drive qualifier | 2 | Use string concatenation or `${variable}` in validation scripts. |
