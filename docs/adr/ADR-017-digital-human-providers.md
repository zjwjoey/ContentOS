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
- Use `SyntheticTimingProvider` in V1; leave ASR/forced alignment as a replaceable provider.

## Consequences

The first version needs a local speech gateway and a provider-facing media staging implementation before real generation can run. Fake providers remain available for CI and contract tests. The new migration is additive and does not rename or remove existing core fields.
