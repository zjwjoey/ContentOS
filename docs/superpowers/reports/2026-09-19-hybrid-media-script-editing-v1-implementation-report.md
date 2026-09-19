# Hybrid Media Script Editing V1 — Implementation Report

Date: 2026-09-19
Branch: `codex/hybrid-media-script-editing-v1`
Base SHA: `7961b5e04f99544159d600865622bc16e8f0e248`
Final SHA: populated after the closure commit

## Delivery status

READY FOR REVIEW. The implementation keeps the hybrid media path deterministic,
persists the resolver decision, and binds that decision directly into the
montage manifest. No merge to `main` was performed.

## Implemented areas

- **Segment → Asset Binding:** `RESOLVED_VISUAL_PLAN_V1` and
  `ResolvedVisualAssignment` carry the selected asset, source, role, score,
  fallback marker, query, reason, and matched keywords; manifest construction
  consumes the exact assignment instead of re-ranking the pool.
- **Entity Classification:** the dictionary covers MIZAN, 东晟, Action, Pepco,
  小陈, 波兰, 华沙 and 中欧; generic concepts such as 物流、市场、讨论 and
  商业合作 are not promoted to authentic entities.
- **Authentic Entity Protection:** authentic brand/company/person/product
  segments require a strong local entity match. An external result is never
  labelled as an authentic entity when the local asset is missing.
- **Neutral B-roll Fallback:** place context is labelled `PLACE_CONTEXT`; other
  unresolved entity segments use `NEUTRAL_BROLL` with `entityFallback: true`.
- **Local Candidate Ranking:** matching uses asset name, path, tags and metadata,
  with entity-hit and usage penalties.
- **Pexels Candidate Ranking:** portrait-first, 9:16-oriented files with a
  preferred resolution range are selected; video candidates are ranked rather
  than blindly taking `results[0]`, and already-used provider identities are
  penalized.
- **Search Cache:** provider search responses are persisted in
  `external_media_search_cache` with a 24-hour expiry and query dimensions.
- **Download Cache:** provider/asset/file identity is checked before download;
  the downloaded object is reused across resolves and workspaces.
- **Asset Provenance:** imported external assets retain provider identity,
  page/creator metadata and the external relation row linking them to the local
  asset.
- **Provider Status API:** GET reads cached status and does not perform a
  network request; POST performs the health check and persists the result.
- **UI / Settings:** source controls are visible outside Advanced, unconfigured
  providers are actionable through Settings, and the UI uses Chinese labels
  such as `帧/秒`.
- **Failure Fallback:** external search/download errors become warnings when a
  local fallback exists; external-only requests fail with a clear Chinese error
  when neither source is available. Staging files are removed in `finally`.
- **Browser acceptance:** the operator browser harness runs the Hybrid flow with
  the deterministic fake provider, including external-only retrieval and local
  plus external source statistics.

## Final Closure

- External identity reuse is tracked separately from local Asset IDs; fresh
  provider identities are preferred and explicit reuse is recorded when the
  candidate pool is exhausted.
- Authentic entity reuse is allowed only through `allowAssetReuse` on the
  resolved assignment; manifest validation remains strict for ordinary Script
  montage duplicates.
- Visual planning and manifest construction share
  `calculateSentenceRequiredDurationMs`; local and external candidates shorter
  than the required duration are ineligible.
- Normal segments require a positive semantic local score before using local
  media. Unrelated local media therefore gives way to a relevant Pexels query.
- Entity and generic fallback statistics are derived from resolved segments and
  are surfaced in history, rather than incremented opportunistically.
- Provenance stores provider/page/creator/file identity, source dimensions,
  duration and download time. Search query remains on assignment/manifest
  matching, not the stable Asset identity.
- Pexels download has an independent 90-second timeout combined with job
  cancellation; external staging is removed in every import failure path.
- Provider missing state clears persisted `usePexels`; provider status failures
  remain `unknown` and do not erase the user's setting.
- Added unit, integration and browser coverage for duplicate provider identity,
  authentic reuse, duration eligibility, relevance threshold, fallback counts,
  download timeout, missing-provider UI, and final manifest binding.

## Verification gates

All gates below were run locally against PostgreSQL on `127.0.0.1:55433` where
the suite requires a database:

- `pnpm format` — 415 files checked
- `pnpm lint` — 149 TypeScript files passed
- `pnpm typecheck` — passed
- `pnpm test` — 259/259 passed
- `pnpm test:migrations` — 9/9 passed
- `pnpm test:auto-edit-v1` — 25/25 passed
- `pnpm test:auto-edit-v15` — 19/19 passed
- `pnpm test:browser` — 3/3 passed (Auto Edit, Editing Workbench, Hybrid)
- `pnpm build` — passed
- `pnpm --dir apps/web build` — passed, 13/13 routes generated
- `pnpm doctor` — passed with one non-blocking warning about the global pnpm
  bin directory not being on PATH
- `git diff --check` — passed

There is no GitHub remote CI status configured for this branch; the local gates
above are the acceptance evidence.

## Known limitations

- Production Pexels calls are not made by the automated gates; the fake provider
  is used for deterministic offline coverage.
- The local `pnpm doctor` PATH warning is environmental and does not affect the
  project scripts.
- This branch is intentionally not merged to `main`; review and merge remain a
  separate action.
