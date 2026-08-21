# Postiz — Phase 1 Report

**Evidence revision:** `74b01ada154a177242d558bedc646fcfed100adf` (`main`). Paths are rooted at `research/repos/postiz-app`.

## 1. Project

An open-source social-media scheduling/publishing platform with a web control plane, many social integrations, calendar/scheduling and analytics-oriented data services.

## 2. Technology stack

pnpm monorepo; Next.js frontend; NestJS backend; Prisma/PostgreSQL-oriented libraries; Temporal workflow integration; React shared libraries; TypeScript. The root workspace and `apps`/`libraries` layout express deployment and dependency boundaries.

## 3. Top-level structure

`apps/frontend`, `apps/backend`, `apps/orchestrator`, `apps/sdk` and `apps/commands` are deployable/entry concerns; `libraries/nestjs-libraries` holds domain/service infrastructure; `libraries/react-shared-libraries` and `helpers` hold shared code. This is the strongest Phase-1 monorepo reference.

## 4. Core modules

```text
Next frontend / public API
  -> Nest controllers and services
  -> Prisma integration/post data
  -> Temporal workflow registration/execution
  -> SocialAbstract provider implementations
  -> external social APIs
```

`integration.manager.ts` registers providers; `social.abstract.ts` defines common failure/transport behavior; `temporal/temporal.register.ts` prepares workflow search attributes.

## 5. Data flow

`apps/backend/src/public-api/routes/v1/public.integrations.controller.ts` authenticates/validates requests then uses `IntegrationService` and `IntegrationManager`. Scheduled publish work is searchable by organization/post through Temporal attributes initialized in `temporal.register.ts`. Provider classes perform platform actions behind `SocialAbstract`; integration/post records persist the control-plane state through database services.

## 6. Communication

HTTP controllers -> Nest dependency-injected services -> database/Temporal -> provider API calls. This is explicit asynchronous workflow orchestration rather than UI-driven polling alone.

## 7. Boundaries

The frontend does not access persistence directly. Provider behavior is insulated by `SocialAbstract`, `SocialProvider` interfaces and `IntegrationManager`; external-platform failure data is normalized/truncated before Temporal serialization. A drawback is the central static provider list in `integration.manager.ts` still requires a source change to register a provider.

## 8. Extensibility

A platform adds a provider implementing the social contract, metadata/DTO/settings, and one registration in `socialIntegrationList`. Provider migration support (`MIGRATE_PROVIDERS`) retains channel identity and scheduled posts while changing the underlying connector—an unusually valuable operational design.

## 9. Error handling

Temporal brings durable workflow retry/status semantics; `social.abstract.ts` bounds error payload sizes and represents common bad-response conditions; search attributes allow failed/running work to be found by organization and post. This is far ahead of the desktop/file-queue projects.

## 10. Data model

Core persisted concepts include Organization, Integration/Channel, Customer/Group and Post; Temporal correlates with `organizationId` and `postId`. ContentOS needs analogous but not identical ContentProject, Account, PublishAttempt, Job and AnalyticsSnapshot records.

## 11. Three designs worth learning

1. Use a monorepo with deployables under `apps` and dependency-safe business capabilities under `libraries`, rather than a single undifferentiated `src` tree.
2. Make a publisher provider conform to an interface/abstract base, and centralize platform-specific transport/error normalization there.
3. Persist provider migration as an operational feature, so an account/platform connector can change without losing scheduled-post history.

## 12. Three designs not to copy

1. Temporal is valuable for durable publishing but overkill for all ContentOS V1 actions; start it only for long-lived, externally retried jobs.
2. A static import/array for every provider is not a true plug-in system; ContentOS should later replace it with manifest-based registration behind a stable SDK.
3. Postiz’s SaaS/multi-organization surface is broader than an initial local-first ContentOS and should not dictate V1 scope.

## 13. Reuse grade

**C — design-only.** It is the primary architecture reference, but the repository is not a code donor for ContentOS.

## 14. License

`LICENSE` and root package metadata state **AGPL-3.0**. Study patterns and create independent implementations; do not copy source into ContentOS.
