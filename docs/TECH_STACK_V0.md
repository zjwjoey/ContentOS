# ContentOS Technology Stack V0

This is the engineering initialization target. It freezes architectural directions while clearly separating confirmed boundaries from library/runtime items that still require a staged acceptance test.

| Concern | V0 decision | Status | Evidence / gate |
|---|---|---|---|
| Runtime | Node.js 22 LTS target | **CONFIRMED** | Existing architecture and Node ecosystem fit; Spike ran on Node 24 as compatibility evidence |
| Language | TypeScript | **CONFIRMED** | Required for contracts, module boundaries and typed workers |
| Backend/API | Fastify + Zod | **CONFIRMED** | Thin versioned JSON control plane in architecture |
| Frontend | React + Next.js | **CONFIRMED** | Web control plane; no Electron-first decision |
| Database | PostgreSQL 16 | **CONFIRMED** | Spike 01 ran against PostgreSQL 16.15 |
| ORM/query layer | Drizzle migrations/query layer | **PROVISIONAL** | Must be validated during Stage 1 migration tests |
| Queue | pg-boss over PostgreSQL | **PROVISIONAL** | Spike passes with conditions; DB lease reconciler remains mandatory |
| Video | FFmpeg behind Video Worker and thin builder | **CONFIRMED** | Spike 02 produces real portrait MP4s; binary/font packaging is gated |
| Browser automation | Playwright behind Publisher Worker/adapters | **CONFIRMED** | Boundary and fake isolation pass; browser/provider smoke test is gated |
| Asset storage | Storage adapter; local filesystem first, S3-compatible later | **CONFIRMED boundary / PROVISIONAL backend** | Spike 03 validates local promotion only |
| Testing | Node test runner during initialization; contract/unit/integration/fixture layers | **CONFIRMED** | Four Spikes and Test Strategy V0 |
| Logging/tracing | Pino structured logs + OpenTelemetry-compatible propagation | **CONFIRMED** | Redaction and correlation are invariants |
| Process model | API/Core plus separately supervised Video and Publisher Workers | **CONFIRMED** | Worker Spike and Worker Architecture V0 |
| Desktop | No Electron-first V0; Web UI + local/server backend | **CONFIRMED** | Desktop packaging deferred |

## Backend decision

Choose **Node.js + TypeScript** over Python for V0. The decisive evidence is the combined need for pg-boss/PostgreSQL delivery, Playwright worker isolation, FFmpeg process control, a typed web control plane and one shared runtime across API, workers and the planned React web surface. Python remains an adapter-level option only where a future capability proves it necessary; it is not a second core runtime.
