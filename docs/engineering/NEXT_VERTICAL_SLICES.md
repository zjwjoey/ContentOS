# ContentOS Next Vertical Slices

The first `Project -> Asset -> Job -> Video` slice and Slice 2 Director foundation are complete. The next slices should proceed in this order, each with its own tests and stage gate:

1. **Slice 3 — Director -> Video:** convert an approved Director output into the existing Video Job and `EDIT_MANIFEST_V0` contract without allowing the Renderer to make creative decisions.
2. **Slice 4 — Fake Publisher:** implement a fake-platform Publisher Worker and adapter contract, including profile isolation, verification/auth failure taxonomy and redaction tests.
3. **Slice 5 — Real platform adapter:** select one platform only after the fake adapter and credential boundary are accepted; add explicit human approval and platform smoke gates.
4. **Slice 6 — Review:** add Review state and human approval gates around render/publish records; keep analytics and multi-platform orchestration deferred until evidence supports them.

Do not start the next slice by building a dashboard, workflow builder, real AI integration or additional platform adapters. Preserve the PostgreSQL Job source of truth, Lease Reconciler, immutable Manifest, atomic Asset promotion and module boundaries established in Architecture V0.
