# Hybrid Media V1 — Final Closure Review

Date: 2026-09-19
Branch: `codex/hybrid-media-script-editing-v1`
Review base: `3afa046ecd06b3d04d075b631c6685115d3324be`

| Closure item | Status | Evidence |
| --- | --- | --- |
| External identity uses provider + providerAssetId sets | FIXED | Resolver separates `usedLocalAssetIds` and `usedExternalProviderAssets`. |
| External candidates avoid adjacent duplicates | FIXED | Fake provider returns two identities; ranking prefers unused and records explicit reuse. |
| Authentic entity reuse | FIXED | Authentic local candidates outrank dedupe; `allowAssetReuse` is persisted and validated. |
| Controlled duplicate manifest binding | FIXED | Manifest permits adjacent reuse only when assignment matching explicitly allows it. |
| Shared required duration | FIXED | `calculateSentenceRequiredDurationMs` is used by VisualPlan and Script Manifest. |
| Short local/external candidates | FIXED | Duration-ineligible candidates are filtered before ranking/selection. |
| Local relevant-first threshold | FIXED | Semantic score is separate from usage penalty; unrelated local media does not satisfy a normal segment. |
| Local generic fallback after provider failure | FIXED | Fallback is marked and counted separately from authentic-entity fallback. |
| Fallback statistics | FIXED | Entity fallback derives from resolved segments; generic fallback has its own count. |
| Complete external provenance | FIXED | Provider identity, file identity, page, creator, dimensions, duration and download timestamp are persisted. Search query remains on assignment/manifest matching. |
| Download cache provenance | FIXED | Identity cache hit reuses the READY asset while assignment source remains PEXELS/FAKE_PEXELS. |
| Download timeout | FIXED | Pexels download has an independent 90-second AbortController timeout combined with job cancellation. |
| Staging cleanup | FIXED | External import removes `hybrid-*` staging files in `finally`. |
| Provider missing UI state | FIXED | Missing status clears persisted `usePexels`; unknown status does not. Browser test covers disabled/unchecked state and Settings link. |
| Reliable phase labels | FIXED | Worker reports coarse analysis/matching and manifest phases; it no longer claims separate search/download phases without callbacks. |
| Pure Local Script Editing | FIXED | Hybrid resolver runs only when Script `usePexels` is enabled; existing planner path remains unchanged. |
| MIX behavior | FIXED | MIX bypasses HybridMediaService and retains Random Sentence Montage. |
| Final manifest regression | FIXED | Integration asserts resolved assignments and final manifest matching/source/role. |
| Browser acceptance | FIXED | Hybrid, external-only and missing-provider UI flows use the fake provider. |
| Full gates | FIXED | Final report records format, lint, typecheck, tests, migrations, auto-edit, browser, build and doctor results. |

## Decision

READY FOR MERGE REVIEW after the closure changes are pushed. No merge to
`main` is performed by this task.
