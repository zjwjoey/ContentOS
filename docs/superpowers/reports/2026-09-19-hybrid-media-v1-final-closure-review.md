# Hybrid Media V1 — Final Closure Review

Date: 2026-09-19
Branch: `codex/hybrid-media-script-editing-v1`
Review base: `9cf177d216e478c988d87a82d6a36d12b29d1996`
Final reviewed SHA: `5e700a5`

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
| MIX/RANDOM strict unique | FIXED | Every source Asset ID is consumed at most once per task; exhaustion returns `EDIT_UNIQUE_MEDIA_EXHAUSTED`. |
| Normal SCRIPT semantics | FIXED | Existing semantic matching and controlled fallback remain unchanged unless the caller explicitly requests local randomization. |
| Hybrid SCRIPT controlled reuse | FIXED | Hybrid prefers unused media and sets `allowAssetReuse` only for authentic or exhausted external candidates. |
| Shared voice timing | FIXED | Worker resolves voice duration once and passes the same timed sentence array through resolver, preparation and manifest. |
| Voice import duplication | FIXED | A supplied voice asset/timing is reused; the worker does not import the same voice twice. |
| Final manifest regression | FIXED | Integration asserts resolved assignments and final manifest matching/source/role. |
| Browser acceptance | FIXED | Hybrid, external-only and missing-provider UI flows use the fake provider. |
| Authentic entity exact match | FIXED | Local ranking exposes matched authentic/place entities separately; `AUTHENTIC_ENTITY` requires a direct authentic match. |
| Place-context fallback integrity | FIXED | Poland-only local footage cannot represent MIZAN and remains `PLACE_CONTEXT` with `entityFallback=true`; the final manifest preserves it. |
| External unused pool and explicit reuse | FIXED | Resolver filters ranked results against provider identity sets explicitly; reuse is marked only after the unused pool is exhausted. |
| Provider-missing settings preservation | FIXED | Missing status only disables Pexels; settings hydration is completed before persistence, preserving local roots/output/template. |
| Health cache bypass | FIXED | Provider health uses a minimal uncached request and never writes search cache; ordinary search cache remains intact. |
| Full gates | FIXED | Final report records format, lint, typecheck, 268/268 tests, migrations, auto-edit, 3/3 browser flows, dedicated three-mode FFmpeg regression, build and doctor results. |

## Decision

READY FOR MERGE REVIEW after the closure changes are pushed. No merge to
`main` is performed by this task.
