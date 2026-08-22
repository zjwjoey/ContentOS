# ContentOS Vertical Slice Status

The first `Project -> Asset -> Job -> Video` slice and Director foundation are complete.

## Completed in this engineering round

1. **Slice 3 - Director -> Video:** an approved Director revision now creates an idempotent `VIDEO_RENDER` Job. The Job payload preserves the Director brief, storyboard and source asset references; the Renderer still does not make creative decisions.
2. **Slice 4 - Fake Publisher:** a platform-neutral Publisher Adapter contract, deterministic Fake Platform, per-account profile isolation, normalized failure taxonomy and publisher worker handler are implemented.
3. **Slice 6 - Review:** append-only `REVIEW_V0` decisions support pending, approved and rejected states, required rejection reasons and API approval gates for render/publish targets.

## Slice 5 status

4. **Slice 5 - Real platform adapters:** adapter code, Worker registration, credential boundary and simulated contract/integration tests are complete for Douyin and WeChat Channels. Douyin uses the official OpenAPI-shaped HTTP adapter; WeChat Channels uses an isolated, headed Playwright session with manual verification. The opt-in smoke command is implemented but has not been run against a real account because credentials, browser profiles and final publish authorization are account-dependent. No private endpoints, cookie extraction or CAPTCHA bypass are included.

The remaining live-platform gate is explicit human-authorized smoke testing with disposable media and a reviewed account. Until that gate is completed, treat external post IDs and platform behavior as unverified.

Analytics, AI review, workflow-builder UI and multi-platform orchestration also remain deferred until evidence supports them. Preserve the PostgreSQL Job source of truth, Lease Reconciler, immutable Manifest, atomic Asset promotion and module boundaries established in Architecture V0.
