# ContentOS Testing and Acceptance Standard

## Test layers

- **Unit:** validators, planners, hashes, state rules, normalization and safety logic.
- **Contract:** Director, AI Provider, Edit Manifest, Publisher Adapter, Review and approval interfaces.
- **Integration:** PostgreSQL, migrations, service transitions, APIs, Jobs, Workers, Publisher state and target binding.
- **Worker:** registration, polling, retries, failure classification, shutdown, lease recovery and cancellation.
- **E2E:** complete vertical slices across the real application composition.

## Full gate

A change is not complete until the relevant repository gate passes:

```bash
pnpm run format
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
pnpm doctor
```

When Web changes:

```bash
pnpm --dir apps/web build
```

`git diff --check` is also required before commit.

## Database acceptance

Migration work must prove clean up, supported forward upgrade, constraints, understood rollback, no orphaned references and correct ordering. Branches with different migration heads require reconciliation before merge. Use an isolated local database; do not use production credentials or shared state as the only evidence.

## Director and Video acceptance

Cover brief creation, Script/Storyboard generation or manual revisions, acceptance/approval, ownership, AI provenance and Video Job creation from the approved current pair. Video coverage must include deterministic planning, valid/invalid manifests, missing/corrupt media, FFmpeg failure, output probe/dimensions/audio/subtitles, atomic promotion, current-attempt fencing and no false-success output.

## Publisher acceptance

Cover exact account/platform and content snapshot selection, approval binding, adapter resolution, success, auth failure, verification challenge, validation failure, browser crash, worker crash, unknown outcome, reconciliation, duplicate prevention, restart behavior and secret redaction. Fake and real adapters share the contract but real smoke is separately gated.

## Real-platform smoke

Real smoke is opt-in and requires an explicit account, platform, authorized credential reference, target content and human approval. It must not bypass CAPTCHA/verification, use stealth circumvention or retry an unknown outcome blindly. Store safe evidence references only. Adapter status is `IMPLEMENTED` after code plus simulated tests and `LIVE-VERIFIED` only after authorized smoke succeeds.

## Approval and Review Analytics

Approval tests prove pending, approve, reject, required rejection reason, immutable history, current decision lookup, ownership and exact target binding. Review Analytics tests are separate and prove metric snapshots, comparisons, safe AI summaries and iteration recommendations when that module is implemented.

## Web and integrated acceptance

Web acceptance requires a production build, correct JSON calls, visible loading/error states, identifiable current revision, clear blocked actions and next action. Before integrating major branches, run one combined Project → Director → Video → Approval → Fake Publisher E2E on the merged branch.

Integration Closure additionally requires the complete `0001`–`0011` migration matrix, real-adapter contract and safety gates, disabled-by-default registry checks, and failure-path E2E for retry, human action and reconciliation. Adapter code is **IMPLEMENTED**, not **LIVE-VERIFIED**, until a separately authorized platform smoke succeeds; Stage 1 does not authorize live calls.

## Definition of Done

A task is done only when requested behavior exists, important behavior is tested, the relevant gate passes, no high-risk issue remains, docs reflect actual status, no secrets are committed and no architecture rule was silently broken.
