# ContentOS Integration Closure and Unified Product Flow Design

**Date:** 2026-08-29  
**Status:** Approved in conversation; written specification awaiting final user review  
**Decision:** Integration stops on `integration/contentos-v1`; it does not merge into `main` automatically.

## 1. Purpose

This design freezes the next two ContentOS stages:

1. converge the existing branch capabilities into one coherent, tested integration baseline;
2. build one browser-operated product flow on that baseline.

The stages are sequential. Stage 2 cannot start until Stage 1 passes its full Gate. Neither stage adds Review Analytics, a real AI provider, or authorized live publishing.

## 2. Verified repository topology

The relevant branch heads at design time are:

| Branch | Head | Role |
|---|---|---|
| `main` | `752e8c4` | stable baseline; contains one unique worktree-ignore commit |
| `codex/director-v1` | `35995d3` | Director V1 and Fake AI vertical slice |
| `codex/publisher-productization` | `7b6c635` | Publisher Fake product closure |
| `codex/publisher-project-integration` | `9ec3ffc` | Publisher-to-Project integration |
| `codex/project-center` | `d257229` | contains all three branches above plus Project Center and reliability repairs |
| `feature/slice-5-real-platform-adapters` | `39fc4cc` | real adapter implementation and migration `0006`; live smoke remains separate |

Git ancestry proves that Director V1, Publisher productization and Publisher project integration are already ancestors of `codex/project-center`. They must not be re-merged independently. The integration base is therefore `d257229`, followed by the unique `main` commit and a controlled reconciliation of the real-adapter branch.

## 3. Options considered

### 3.1 Promote Project Center to the integration base — selected

Create `integration/contentos-v1` from `codex/project-center`, merge `main` to record ancestry, then integrate the real-adapter code behind disabled authorization gates. This preserves the existing linear product history and minimizes duplicate conflicts.

### 3.2 Start from main and merge every branch

This repeats commits already present in Project Center and creates avoidable conflicts in contracts, Publisher, API, Web and planning files. Rejected.

### 3.3 Rebuild by cherry-picking selected commits

This could shorten history but risks omitting safety fixes, tests, ADRs and recovery behavior. Rejected.

## 4. Stage 1 — Integration Closure

### 4.1 Goal

Produce and push a green `integration/contentos-v1` branch containing the current Project Center/Director/Publisher/Video baseline and real-platform adapter implementation, with real adapters disabled by default. Stop before merging to `main`.

### 4.2 Integration sequence

```text
codex/project-center@d257229
  -> create integration/contentos-v1 in a dedicated worktree
  -> merge main@752e8c4
  -> reconcile feature/slice-5-real-platform-adapters@39fc4cc
  -> repair migrations/contracts/workers/configuration
  -> combined API/Worker E2E
  -> full Gate and independent review
  -> push integration/contentos-v1
  -> stop for user review
```

The real-adapter branch is integrated as code, tests and schema only. No account authorization, credential import or real platform request is part of Stage 1.

### 4.3 Migration contract

The accepted migration sequence is:

```text
0001_initial
0002_job_progress
0003_project_name
0004_director_plan
0005_review
0006_publisher_state
0007_director_v1
0008_ai_provenance
0009_publisher_foundation
0010_approval
0011_render_attempt_fencing
```

`0006` is taken from the real-adapter line and reconciled with the newer Publisher Foundation rather than renumbering already-shared `0007`–`0011` files. Acceptance requires clean-database up, supported forward upgrades, understood down/up behavior, correct foreign keys and no migration-file rewriting.

An existing disposable test database that applied `0007`–`0011` without `0006` is not evidence of a valid production upgrade path. Stage 1 uses new isolated databases for each supported starting state.

### 4.4 Conflict ownership

| Area | Resolution authority |
|---|---|
| Publisher records, snapshots, attempts and external posts | current Publisher Foundation contracts and owning services |
| Douyin/WeChat behavior | adapters behind `PublisherAdapter` |
| Credential access | injected credential provider only |
| Approval | exact immutable Publish Revision/Render target binding |
| Project status | public Project/Publisher coordination contracts |
| Job lifecycle | current fenced Job/attempt/lease contracts |
| Video finalization | current atomic Asset/Render/Job attempt transaction |
| Project Center | read-only composition through public module queries |

Merge resolution must not restore old direct database stores, bypass the Publisher Foundation, weaken reconciliation or allow platform code to cross-write domain tables.

### 4.5 Runtime composition

The combined environment composes Director, Video and Publisher Workers without handler shadowing. PostgreSQL remains business truth; polling/delivery is execution plumbing. Workers support lease renewal, cancellation, restart recovery, idempotency and graceful shutdown.

Real adapters are absent from the default registry unless an explicit environment configuration and credential provider are supplied. Fake Publisher remains the default acceptance adapter.

### 4.6 Combined system path

The Stage 1 system E2E runs through public APIs and composed workers:

```text
Project
 -> Brief
 -> Fake AI Script Job
 -> Script acceptance
 -> Storyboard Job and approval
 -> Video Job and FFmpeg Render
 -> exact Render Approval
 -> immutable Publish Revision and approval
 -> Fake Publisher Job
 -> confirmed ExternalPost
 -> Project Center PUBLISHED
```

Tests may inspect persisted results for assertions, but they must not invoke private handlers to manufacture success.

### 4.7 Error and safety requirements

- Merge or migration uncertainty blocks later tasks; it is not resolved by deleting history.
- Credentials, cookies, authorization headers and browser state never enter commits, normal logs or Job payloads.
- Unknown publish outcomes enter reconciliation and never blind retry.
- Old Job/Render attempts cannot finalize newer work.
- Missing adapter authorization fails closed before an external request.
- Each integration checkpoint is committed separately so a failed merge can be reverted without discarding unrelated work.

### 4.8 Stage 1 Gate

Required evidence:

- linear `0001`–`0011` migration chain and forward-upgrade tests;
- format, lint, typecheck, full tests, root build, Web build, doctor and `git diff --check`;
- combined system E2E;
- no secret-shaped committed value;
- no cross-module private table access;
- independent review with no Critical or Important findings;
- pushed `integration/contentos-v1` matching the reviewed commit.

Estimated effort: 4–7 working days. The main uncertainty is the Publisher real-adapter reconciliation, not the already-linear Director/Publisher/Project Center history.

## 5. Stage 2 — Unified Product Flow

### 5.1 Goal

Allow an operator to complete the Fake end-to-end workflow from the Web UI without database access, test scripts or manual Worker invocation.

```text
Projects
 -> Project Center
 -> Director
 -> Assets
 -> Video
 -> Approval
 -> Publisher
 -> Project Center PUBLISHED
```

### 5.2 Product boundaries

Stage 2 adds the minimum UI/API/Worker capabilities needed for the flow. It does not add a timeline editor, advanced Video templates, real AI, live platform enablement, post-publish analytics, multi-tenant permissions or a generic workflow engine.

Project Center remains a read-only composition layer. All commands are routed to owning module application services.

### 5.3 Navigation and project entry

The project list supports create, status, next action and navigation. Project Center becomes the product shell and exposes Overview, Director, Assets, Video, Approval and Publisher stages. It identifies the current immutable target, active Job, blocker and one safe next action.

### 5.4 Durable asset ingestion

Browser media ingestion is asynchronous:

```text
upload/stage file
 -> create ASSET_IMPORT Job
 -> Asset Worker hashes, probes and promotes
 -> READY Asset linked to ContentProject
 -> UI observes terminal state
```

HTTP handlers may stream to staging and validate bounds, but they do not run FFmpeg/FFprobe or perform long promotion work. Upload errors, duplicate content, probe failure and cancellation are durable and visible.

### 5.5 Director stage

The existing Director V1 UI is integrated into the shell and keeps append-only Script/Storyboard revisions, current accepted/approved pointers, Fake AI Job polling and provenance. A successful Storyboard approval exposes the Video next action directly.

### 5.6 Minimal Video stage

The stage selects project-owned READY assets, creates a Video Job from the current approved Director pair, observes progress, supports cancellation, previews the successful output, lists Render history and creates an Approval for the exact Render. Advanced editing and template controls remain Stage 3 work.

### 5.7 Approval stage

This stage handles only pre-publish Approval. It displays the exact Render or Publish Revision, current decision, immutable history, preview, approve/reject actions, required rejection reason and stale-target warnings. “Review” remains reserved for post-publish analytics.

### 5.8 Publisher stage

The Publisher UI creates/selects a Fake Account, selects an approved Render Asset, creates an immutable Publish Revision, obtains exact approval, queues the durable Job and displays attempts, human-action states, reconciliation and confirmed ExternalPost. It does not expose real adapters by default.

### 5.9 Shared product state

The UI presents product language (`Waiting`, `In progress`, `Needs approval`, `Needs human action`, `Failed`, `Complete`) while technical details remain in bounded diagnostics. Every failure answers what happened, whether recovery is automatic, what the operator must do and whether duplicate publishing is possible.

### 5.10 Browser acceptance paths

Browser-level tests cover the success path plus asset failure, Video retry/cancel, stale approval rejection, Publisher auth/human action, unknown outcome reconciliation and refresh/restart durability. System assertions use public APIs and persisted business state.

### 5.11 Stage 2 Gate

Required evidence:

- complete Fake flow from project creation to `PUBLISHED` through the Web UI;
- no manual Worker execution or database intervention;
- state survives refresh and process restart;
- exact revision/target approvals cannot be bypassed;
- no credentials, raw Job payloads or private diagnostics reach the browser;
- full unit/contract/integration/worker/E2E suite and production Web build pass;
- independent product/code review has no high-risk findings.

Estimated effort: 8–12 working days. Durable browser asset ingestion is the largest new backend slice; the other stages primarily expose existing capabilities safely.

## 6. Stage boundary and handoff

Stage 1 produces a trustworthy integration branch. Stage 2 branches from the accepted Stage 1 head. Failure of any Stage 1 Gate keeps Stage 2 closed. Each stage receives its own implementation plan, execution branch/worktree, verification report and user approval checkpoint.

