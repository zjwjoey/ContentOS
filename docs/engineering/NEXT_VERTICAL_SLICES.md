# ContentOS Vertical Slice Status

The first `Project -> Asset -> Job -> Video` slice and Director foundation are complete. The implementation roadmap is frozen as Publisher Fake closure, Publisher-to-Project integration, Project Center, Video MVP, post-publish Review and only then real platform adapters.

## Completed in this engineering round

1. **Slice 3 - Director -> Video:** an approved Director revision now creates an idempotent `VIDEO_RENDER` Job. The Job payload preserves the Director brief, storyboard and source asset references; the Renderer still does not make creative decisions.
2. **Slice 4 - Fake Publisher:** a platform-neutral Publisher Adapter contract, deterministic Fake Platform, per-account profile isolation, normalized failure taxonomy and publisher worker handler are implemented.
3. **Slice 6 - Approval compatibility:** the pre-freeze approval decision path remains available for compatibility; new Publisher work uses the `APPROVAL_V0` contract and exact revision gates.

## Explicitly deferred

4. **Slice 5 - Real platform adapter:** deferred by decision. Douyin and WeChat Channels are the initial candidate platforms, but no real account, credential, browser session or platform call is included. Future adapters must pass explicit credential-boundary, human-confirmation and platform smoke-test gates behind the existing Publisher Adapter contract.

Post-publish analytics, AI Review, workflow-builder UI and multi-platform orchestration remain deferred until evidence supports them. Preserve the PostgreSQL Job source of truth, Lease Reconciler, immutable Manifest, atomic Asset promotion and module boundaries established in Architecture V0.

## Formal gate status

- **Slice ① — Publisher Fake product closure: APPROVED (2026-08-22).** Account, PublishRequest/Revision, exact-revision Approval Gate, durable `PUBLISH`/`PUBLISH_RECONCILE` Jobs, Worker execution, PublishAttempt and confirmed ExternalPost have passed acceptance.
- **Slice ② — Publisher-to-Project integration: IMPLEMENTED, PENDING ACCEPTANCE.** The implementation is isolated on `codex/publisher-project-integration`; formal acceptance is required before opening Slice ③.
- **Slices ③–⑥: CLOSED.** Project Center, Video MVP, post-publish Metric Snapshot/AI Review and real Douyin/WeChat adapters remain closed until each preceding gate is accepted.
