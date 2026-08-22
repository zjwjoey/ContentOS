# ContentOS Research Findings

## Research scope

Phase 1 studies five repositories for architectural patterns that may inform ContentOS. The final output must retain exact source paths and separate learning from direct reuse.

## Evidence log

- MatrixMedia demonstrates a practical desktop publishing surface but has no durable job queue and is GPL-2.0-only.
- AI Short Video Factory is a narrow FFmpeg/Electron render reference; its renderer-to-generic-SQL IPC is not an acceptable server boundary and it is AGPL-3.0.
- MoneyPrinterTurbo has the best Phase-1 video-stage/service split and provider-neutral LLM configuration, but its in-process execution must be replaced by durable jobs for ContentOS.
- AutoSocial makes queue outcomes operationally tangible through pending/posted/failed filesystem locations; ContentOS should promote these into database-backed PublishAttempt states.
- Postiz is the best reference for a monorepo control plane, provider abstraction and durable workflows, while remaining AGPL-3.0 and too broad to adopt as a foundation.
- The synthesized recommendation is Modular Monolith + PostgreSQL/object storage + durable worker queue, with independently deployed Video and Publisher workers.
- Phase 2 retains that architecture, adds a renderer-neutral Edit Manifest, fixed V1 workflow services, model/provider registry, and prompt provenance.
- V1 video rendering is direct FFmpeg through a thin internal command builder; Remotion is an optional later template/preview renderer subject to license review.
- Job truth belongs in PostgreSQL with durable queue delivery, process-isolated workers, idempotency keys, leases, attempts and explicit `BLOCKED` human-action states.
- Architecture V0 formalizes this as a modular-monolith control plane, independent Video/Publisher workers, immutable revision records and a fixed V1 Director -> Video -> Publish -> Review process.
- The V0 technology recommendation is TypeScript/Node 22 with Fastify, PostgreSQL, an evaluated pg-boss queue, FFmpeg and Playwright; only the architectural boundaries are accepted before the initialization spike.
- Spike execution is now authorized, but only as disposable verification code under `spikes/`; the four Spike reports are the gate for engineering initialization.

## Decisions

| Decision | Rationale |
|---|---|
| Use local code inspection plus official repository metadata | The user requires source-backed conclusions and reproducible commit references. |
| Recommend a modular monolith with isolated workers | It preserves clear domain boundaries and operational isolation without premature microservice overhead. |
| Use direct FFmpeg for V1 | It best matches deterministic simple composition while retaining a future renderer-neutral manifest boundary. |
| Keep workflows fixed in V1 | It provides reliable dependencies without building a generic graph editor. |
| Use an immutable Edit Manifest boundary | It keeps creative intent reproducible and prevents renderer-side editorial drift. |
| Treat browser publish uncertainty as a state | It avoids dangerous blind reposts after interrupted browser automation. |

## Issues

## Publisher safety review findings — 2026-08-22

- `storage/publisher-profiles/` and `artifacts/publisher/` were not ignored even though they can contain browser session state and screenshots.
- `workers/publisher-worker/src/main.ts` started the Stage-4 no-op handler when executed directly.
- Real adapters defaulted to `InMemoryPublishStateStore`; restart and unknown-state reconciliation were unsafe.
- PUBLISH approvals did not bind a Review decision to an immutable asset/content snapshot.
- The Douyin adapter used an undocumented create path. Current official documentation specifies `POST /video/create/`; its ambiguous responses cannot be safely matched from the list API alone.
- The WeChat adapter checked its success selector immediately after click and returned a synthetic external ID.
- The smoke command printed failed outcomes with process exit code zero.

## Final Architecture V0 Freeze Findings

- The complete Architecture V0 package, all ten ADRs and all four Spike reports were reviewed together.
- All four Spike change requests are accepted as clarifications; no architecture redesign is justified by the evidence.
- Three named contract documents were missing and are now explicit: Job, AI Provider and Publisher Adapter.
- The frozen implementation direction is Node.js 22 LTS + TypeScript with PostgreSQL 16, Fastify/Zod, React/Next.js, FFmpeg, Playwright behind adapters, a storage adapter and independently supervised workers.
- pg-boss, Drizzle, FFmpeg binary/font packaging, real Playwright/browser versions and object-store commit semantics remain staged/provisional gates rather than hidden assumptions.
- Final gate: APPROVED FOR ENGINEERING INITIALIZATION, with the staged plan and A/B conditions; no initialization was executed.

| Issue | Resolution |
|---|---|
| The pasted requirement opened with mojibake in PowerShell | Recovered the UTF-8 content semantically; repository and report paths are explicit in the request. |
| MoneyPrinterTurbo clone is incomplete | Reports cite the immutable remote SHA and exact verified source paths; no conclusions use incomplete local clone contents. |
