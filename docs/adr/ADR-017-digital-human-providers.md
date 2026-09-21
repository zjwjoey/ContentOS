# ADR-017: Digital Human Provider Boundaries

Status: Proposed for V1 implementation

## Context

ContentOS needs a production path from script text to speech, avatar lip-sync, subtitles, and the existing renderer. TTS and avatar vendors have different local/remote lifecycles and must not leak into HTTP handlers, ordinary logs, or Job payload secrets.

## Decision

- Add independent `SpeechProvider`, `AvatarProvider`, `AlignmentProvider`, and `ProviderMediaStaging` contracts under `packages/contracts`.
- Persist Voice Profile, Avatar Profile/Clip, Speech Generation, and Avatar Generation records in PostgreSQL.
- Submit generation work as durable `SPEECH_GENERATE` and `AVATAR_LIPSYNC_GENERATE` Jobs with idempotency keys.
- Keep provider credentials in environment/secret configuration. Jobs carry only project, generation, and correlation identifiers.
- Persist an external avatar task ID before polling or retrying, so worker recovery cannot duplicate paid submissions.
- Store completed output through the existing Asset service and continue to use the existing Edit Manifest/Renderer path.
- Treat READY project `OUTPUT` AUDIO/VIDEO Assets as valid renderer inputs so generated Speech output can flow through the existing Video Worker without a second media pipeline.
- Use the existing project-scoped `edit_manifests.idempotency_key` plus a transaction advisory lock for Digital Human handoff, so concurrent requests converge on one Edit Manifest and one idempotent render Job.
- Preserve remote billing quantity and unit alongside amount/currency when the provider reports them; absent provider billing data remains nullable.
- Include the selected Avatar Profile/Clip and Speech Asset identity, as well as their checksums, in the Avatar request hash so the same media reused under different profiles is not incorrectly merged.
- Validate provider-declared speech limits and capabilities at both API submission and Worker execution boundaries, including reference audio, provider voice IDs, language, speed, emotion, and maximum text length.
- Keep Voice/Avatar Profiles and Clips traceable through PATCH plus soft-delete (`DISABLED`) operations; hard deletion is intentionally avoided because generations retain foreign-key provenance.
- Expose an API-level Avatar preflight that returns safe `READY`/`BLOCKED` checks before creating a paid generation Job; retain the same checks in the Worker as a second boundary for races and non-HTTP invocations.
- Use `SyntheticTimingProvider` in V1; leave ASR/forced alignment as a replaceable provider.

## Consequences

The first version needs a local speech gateway and a provider-facing media staging implementation before real generation can run. Fake providers remain available for CI and contract tests. The new migration is additive and does not rename or remove existing core fields.
