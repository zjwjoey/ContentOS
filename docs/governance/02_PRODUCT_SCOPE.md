# ContentOS Product Scope

> Purpose: define the product boundary and the V1 acceptance target.

## Primary operator

The first user is an individual operator or small content team managing a repeatable short-video pipeline:

- brief and topic planning;
- scripts and storyboards;
- local media assets;
- deterministic video planning and rendering;
- human approval;
- platform publishing;
- post-publish metrics and iteration.

## Primary object: `ContentProject`

A project is the top-level traceability and UI unit. The eventual project view exposes:

```text
identity and topic
planned publish date and target platforms
current stage and blocked reason
Director brief, Script revisions and Storyboard revisions
source assets, Video Jobs and Render outputs
approval decisions and publish requests
external post identities, metric snapshots and AI review
```

## Core modules

### Content Project

Owns project identity, project metadata and project existence. It does not duplicate Director, Video, Publisher or Review private state.

### Director

Owns brief, script and storyboard intent, append-only revisions, acceptance/approval transitions and AI provenance. Director output is creative intent, not renderer instructions invented at runtime.

### Video

Converts an approved Director target into an idempotent Video Job, builds a deterministic edit plan, persists `EDIT_MANIFEST_V0`, renders with FFmpeg, probes output, promotes the result and preserves provenance.

### Publisher

Owns accounts, immutable publish snapshots, approvals bound to exact targets, adapter dispatch, attempts, external post identities, normalized failures and reconciliation. Initial platform targets are Fake Platform, Douyin and WeChat Channels, with real access always behind explicit authorization gates.

### Human Approval

Owns approve/reject decisions for concrete immutable Render or Publish targets. A rejection requires a reason and historical decisions remain queryable. “Review” is reserved for post-publish analytics.

### Review Analytics

Future/early capability for metric snapshots, plays, likes, comments, saves, shares, deltas, historical comparisons, AI summaries and recommendations back to Director. Human Approval does not count as Review Analytics completion.

## MVP flow

```text
Create Project
  -> enter Brief
  -> generate or write Script
  -> accept Script
  -> generate or write Storyboard
  -> approve Storyboard
  -> create Video Job
  -> render and inspect output
  -> approve Render target
  -> create Publish snapshot
  -> approve exact Publish snapshot
  -> publish through Fake or authorized adapter
  -> persist final state and external identity
```

The Project Center should answer “what stage?”, “what is blocked?”, “what is next?”, “which revision is current?”, “what is running?”, “what is approved?” and “what is published?” without reading another module’s private tables directly.

## Explicit non-goals for the current phase

Do not prioritize a full timeline editor, generic no-code workflow engine, dozens of platforms, multi-tenant billing, complex enterprise permissions, cloud render farms, CAPTCHA bypass, stealth browser behavior, automatic cookie evasion, blind retry after unknown publishing outcomes, a large analytics warehouse or native mobile applications.

## V1 completion target

One integrated branch must demonstrate Project → Director V1 → Video → Human Approval → Publisher with one migration chain, one Web UI path, a complete automated suite, a working Fake Publisher and real adapters present only behind explicit authorization gates. “Implemented” and “LIVE-VERIFIED” are different statuses.
