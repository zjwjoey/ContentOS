# ContentOS Architecture V0 Summary

## 1. Architecture

ContentOS V0 is a modular monolith control plane with two independent execution processes: Video Worker and Publisher Worker. Core owns orchestration; PostgreSQL records business truth; storage holds canonical media.

## 2. Technology stack

Frozen engineering direction: Node.js 22 LTS + TypeScript, pnpm workspaces, Next.js/React web UI, Fastify/Zod API, PostgreSQL 16/Drizzle, pg-boss delivery candidate with database lease reconciliation, FFmpeg renderer, Playwright publisher behind adapters, local-to-S3 storage adapter and Pino/OpenTelemetry-compatible observability. Exact ORM, queue packaging, FFmpeg binary/font package and real browser/provider versions remain staged gates.

## 3. Modules

Project, Director, Asset, Video, Publisher, Review, Job and AI have exclusive ownership and public contracts. No module reaches into a sibling's persistence tables.

## 4. Data

`ContentProject` links append-only creative revisions, assets, manifests, renders, publish requests/attempts, reviews and jobs. Project/Render/Publish/Job lifecycles remain independent. Assets are immutable canonical records.

## 5. Jobs

Jobs are durable records with attempts, leases, events, retry policy, cancellation and idempotency. They run the frozen sequence: Director -> Video -> Approval Gate -> Publish -> post-publish Review.

## 6. Video

Director-approved planning becomes an immutable `EDIT_MANIFEST_V0`. Video creates a render Job; the Video Worker invokes direct FFmpeg and validates output before Asset promotion. The renderer cannot make creative choices.

## 7. Publisher

Publisher snapshots a request and schedule, then a separate Worker uses Playwright through platform adapters. Credentials are references only. Uncertain external post state requires reconciliation before retry.

## 8. AI

AI is provider-neutral via capability contracts, ModelRegistry and versioned prompts. AI results are schema-validated, provenance-recorded and only become creative truth when Director accepts them.

## 9. Assets

Asset/Derivative/ProjectAsset separates canonical content, derived output and project role. Staging plus checksum validation precedes promotion; storage implementation is replaceable.

## 10. Principal risks

- Platform UI changes, re-authentication and uncertain browser-publish outcomes.
- FFmpeg portability and host CPU/disk pressure on Windows.
- Queue lease/retry correctness and duplicate external side effects.
- AI structured-output reliability, cost control and sensitive prompt handling.
- Early scope expansion into generic workflows or templates.

## 11. Provisional decisions to validate

Drizzle, pg-boss operational packaging, local storage promotion behavior, Windows worker supervision, FFmpeg packaging/font capability and real Playwright profile isolation require staged initialization acceptance. The architecture contracts do not depend on replacing these concrete adapters.

## 12. Verdict

**FROZEN FOR ENGINEERING V0.** ContentOS is approved for staged engineering initialization under `docs/ENGINEERING_INITIALIZATION_PLAN.md`, with the A/B conditions in the final Freeze Report. This is not approval for full V1 feature implementation or real platform adapters.
