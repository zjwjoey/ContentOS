# Digital Human V1 Implementation Report

## Scope

The supplied `DIGITAL_HUMAN_V1_DESIGN.md` and isolated-development prompt were treated as project specifications. The user request is the delivery objective: complete the implementation in an isolated branch and push it to the remote repository.

## Implemented

- Independent provider contracts for speech, avatar, alignment, and provider media staging.
- IndexTTS 2.5 HTTP adapter and fake speech provider.
- AvatarProvider contract boundary and fake avatar provider; the unverified cloud API remains intentionally unwired.
- Synthetic sentence timing provider.
- PostgreSQL migrations `0031`–`0037` are present from the current `origin/main` sequence, followed by Digital Human migrations `0038_digital_human.sql` and `0039_digital_human_billing.sql` with Voice Profile, Avatar Profile/Clip, Speech Generation, Avatar Generation, and nullable remote billing quantity/unit fields.
- Digital Human service with project ownership checks, Asset readiness checks, provenance fields, output Asset references, and request-hash idempotency.
- API routes under `/api/v1/projects/:projectId/digital-human/*`.
- Durable speech/avatar worker handlers with retry behavior and external-task recovery.
- Runnable local Worker composition with explicit `SPEECH_GENERATE` / `AVATAR_LIPSYNC_GENERATE` polling and expired-lease recovery (`pnpm dev:digital-human`).
- The Worker package now has a real `start` entrypoint and graceful shutdown waits for in-flight polling/Jobs before closing the runtime and database; the composition-only module remains protected from direct execution.
- Project workspace entry at `/projects/:id/avatar`.
- Runtime provider selection through environment/config, with fail-closed unavailable providers when production credentials or gateways are missing.
- Capability checks now fail closed for unconfigured speech/avatar providers instead of reporting synthetic capability objects as `READY`; media staging readiness is exposed alongside provider capabilities.
- Provider capability preflight before creating speech/avatar Jobs: required reference audio, remote provider availability, and public media staging are surfaced as actionable API errors instead of creating doomed work.
- Stable request-derived Generation/Job identifiers plus `INSERT ... RETURNING` conflict handling prevent concurrent idempotent requests from creating orphan Jobs; the integration test exercises concurrent Speech and Avatar submissions.
- The shared Job idempotent insert path now handles concurrent primary-key and idempotency-key races without creating duplicate or orphaned Jobs.
- The `AvatarProvider` contract is the only cloud-avatar API boundary in V1; no vendor-specific URL, credential, auth, request field, or response field mapping is shipped without an official contract.
- Built-in HMAC/TTL Provider Media Staging is available with `CONTENTOS_MEDIA_STAGING_PROVIDER=signed-url`; ContentOS serves only READY AUDIO/VIDEO Assets through a signed query URL and never exposes `STORAGE_ROOT` or persists the temporary URL.
- The avatar contract preserves normalized status, model version, cost, and provider provenance for a future implementation; result downloads require HTTP(S) and honor Job cancellation signals.
- The avatar contract includes provider-reported amount, currency, billing quantity, and billing unit for a future implementation.
- Job cancellation now persists Speech/Avatar generation `CANCELLED` state and invokes the optional remote avatar `cancelTask`, including the race window immediately after remote submission; a worker regression test covers external-task cancellation.
- Digital Human lease recovery now supplies a cancellation handler for expired `CANCEL_REQUESTED` Jobs, so a Worker loss cannot leave the Job stranded and an existing external Avatar task is cancelled during recovery.
- Failed or cancelled Speech/Avatar requests can be explicitly retried through dedicated API/UI actions; terminal local Jobs are requeued idempotently, and a prior remote Avatar task is replaced only after the provider reports `FAILED` or `CANCELLED`.
- Retry endpoints now require the backing durable Job to be terminal before requeueing, so a Generation cancellation race cannot report a retry while the original Job is still running or cancelling.
- Avatar preflight now requires positive source/audio durations, checks provider video/audio formats and maximum duration before staging or charging the remote provider, and completion writes are conditional on the Generation remaining active, preventing cancellation races from becoming false successes.
- The `AvatarGenerationRequest` contract carries the stable Generation request ID so a future provider implementation can deduplicate submit-after-uncertain-write recovery without changing the service boundary.
- Durable Job execution now supports explicit deferred polling: an external Avatar task that remains `QUEUED`/`RUNNING` is rescheduled without consuming the Job's terminal retry budget, so long-running paid tasks do not become false failures after a fixed number of polls.
- Remote Avatar result downloads now have a separately configurable timeout (`CONTENTOS_AVATAR_RESULT_TIMEOUT_MS`) and abort/cleanup partial work when the timeout expires.
- Worker-side result handling uses a dedicated SSRF boundary: literal and DNS-resolved IPv4/IPv6 addresses are checked against private, loopback, link-local, mapped-private, multicast, reserved, and documentation ranges; blocked hostnames are rejected; redirects are manual, bounded, and revalidated at every hop. Native fetch DNS pinning remains an infrastructure concern outside this TypeScript boundary. Avatar Clip usage counters and `last_used_at` are updated only for the first idempotent generation request.
- Remote Avatar result downloads now stream directly to staging with a configurable byte limit (defaulting to the asset upload limit), reject oversized responses before Asset import, and clean partial files on failure.
- Speech provider requests now have configurable bounded timeouts (`CONTENTOS_PROVIDER_REQUEST_TIMEOUT_MS` / `CONTENTOS_PROVIDER_CAPABILITY_TIMEOUT_MS`) and normalize network/timeout failures as retryable provider outages.
- Provider Media Staging now rejects loopback, private-network, `.local`, and `.internal` base/result URLs; runtime capability readiness is false when the configured staging address cannot be publicly reached, and signed staging tokens are project-bound before serving READY media.
- The HZAgent/cloud-avatar API portion is intentionally interface-only in V1; runtime selection exposes only the `AvatarProvider` boundary and returns an explicit unavailable state for the default `hzagent` provider.
- Runtime provider identity is fail-closed across API requests, persisted Generations, worker configuration, capability responses, and provider results; a mismatched client or stored Generation is rejected instead of being silently attributed to another provider.
- Avatar preflight no longer depends on SpeechProvider online health once a READY AUDIO Asset already exists; it checks Avatar capability, source media, duration, format, and staging requirements only.
- Speech speed is unified to the provider-supported range `0.5`–`2.0` across contracts, API validation, service validation, UI controls, IndexTTS gateway behavior, and capabilities; out-of-range values are rejected rather than clamped.
- Synthetic subtitle timeline export as Edit Manifest cues, SRT, and ASS through the Speech Generation API.
- SRT/ASS subtitle downloads now persist idempotent `TEXT` Assets with project ownership and expose the Asset content route, so subtitle files are traceable and reusable rather than transient response bodies.
- A real PostgreSQL temporary-schema Worker vertical slice now runs the durable `AVATAR_LIPSYNC_GENERATE` handler, fetches a remote result through the staging boundary, and imports it as a distinct READY project `VIDEO` Asset with duration metadata and provider task provenance.
- READY `OUTPUT` AUDIO Assets are now accepted by the shared render asset catalog, closing the generated Speech Asset handoff into the existing Video Worker input path.
- Speech completion now prefers the duration probed from the imported AUDIO Asset while retaining the provider-reported duration in provenance, so subtitle timing follows the stored media when both measurements are available.
- Worker preflight failures now transition the corresponding Speech/Avatar Generation to `FAILED` instead of leaving it `RUNNING`; API and Workspace cancellation controls request Job cancellation and persist Generation `CANCELLED`, while cancelling an existing remote Avatar task before local cancellation and preserving the Worker race-safe cancellation path.
- Capability endpoint at `/api/v1/projects/:projectId/digital-human/capabilities`, with the UI displaying live speech/avatar availability instead of assuming a provider is configured.
- Successful Avatar Generations can now create an idempotent `EDIT_MANIFEST_V0` plus the existing `VIDEO_RENDER` Job; the workspace redirects to the existing video editor, preserving generated speech, synthetic subtitle cues, 9:16 canvas, and FFmpeg rendering.
- Digital Human Edit Manifest handoff now uses the existing project-level idempotency index and transaction advisory lock, with a concurrent integration test proving two handoff requests converge on one manifest and one render Job.
- Avatar request hashes now include Profile/Clip/Speech Asset identities in addition to media checksums, preventing cross-profile deduplication when the same source media is reused intentionally.
- Speech capability preflight now validates provider voice IDs, reference-audio support, language, speed, emotion, and provider-declared text limits at both API and Worker boundaries.
- Voice Profiles, Avatar Profiles, and Avatar Clips now support scoped edits and trace-preserving soft deletion through the API; the Workspace can upload reference audio and avatar clips through the existing durable Asset Import pipeline and wait for the resulting Asset ID.
- Avatar generation now exposes a safe API preflight returning `READY`/`BLOCKED` checks for Assets, durations, runtime/provider health, formats, duration limits, and public staging; the Workspace must pass this preflight before creating the paid-generation Job, while the Worker keeps a second defensive preflight.
- Avatar preflight and Worker execution now require `videoToVideo` for the current video-clip input path; image-only providers are blocked instead of being incorrectly treated as compatible.
- Avatar API idempotency now takes precedence for already active/successful request hashes: a transient Provider capability outage cannot turn an existing Generation/Job lookup into a new failure; fresh requests and terminal retries still require preflight.
- Loopback IndexTTS gateway source at `tools/indextts-gateway/gateway.py` with input-root allowlisting, output-root isolation, request correlation logging, and `/health`, `/capabilities`, and `/v1/speech/generate` endpoints.
- Workspace UI actions for Voice Profile, Avatar Profile, Avatar Clip, speech generation, avatar generation, output preview, and subtitle download.
- Workspace library controls now edit Voice defaults/status, edit Avatar metadata/status, soft-disable and restore Profiles/Clips without deleting provenance, and capture/display Clip scene, gesture, tags, usage count, and recent-use metadata; generation controls remain disabled unless the relevant provider capability is explicitly `READY`.
- Contract/provider/worker/config tests and a proposed ADR.
- Remote Avatar result authenticity validation is now fail-closed after download: strong HTML/JSON/XML/text content types are rejected, the response body is streamed under the byte limit, and the temporary file is validated with injected `ffprobe` metadata requiring a real video stream, positive duration, positive dimensions, a codec, and a known format. Probe-derived duration/width/height/format/codec are persisted on the output Asset and Generation provenance; provider task metadata remains in provenance. Download, probe, import, cancellation, and validation failures clean staging files and classify invalid media as non-retryable while preserving bounded download retryability.
- The provider-neutral Avatar Contract Test Kit now checks capability identity, supported status/capability shapes, successful task identity, request-idempotent submission, task provenance/cost fields, terminal cancel stability, and the normalized provider error vocabulary. `FakeAvatarProvider` passes it without introducing a vendor adapter.
- The isolated browser harness now runs the Digital Human flow through the real web UI, API, PostgreSQL schema, durable Jobs, fake Speech/Avatar providers, remote-result proxy, Asset import, and existing Edit Manifest handoff. It verifies successful Speech and Avatar outputs, `READY` preflight, 9:16 Edit Manifest/subtitle/audio binding, and a browser-visible `UNAVAILABLE` Avatar capability case. The harness uses direct local `tsx`/`next` executables when the worktree has a shared `node_modules` Junction, avoiding pnpm task-state false failures.

## Verification

- Targeted TypeScript compilation: passed.
- Digital Human/config/worker unit tests and provider contract checks: passed.
- Digital Human/API/provider suite: 58/58 tests passed, covering the interface-only avatar boundary and fake provider, SSRF-safe remote result handling, provider identity mismatch rejection, the real PostgreSQL temporary-schema EditManifest/VIDEO_RENDER flow, the Worker-to-Asset vertical slice, probed Speech Asset duration, Speech-offline Avatar preflight, API cancellation, lease-recovery cancellation, graceful shutdown waiting, Worker preflight failure recording, bounded speech-provider failures, project-bound signed staging, subtitle Asset persistence, public-staging URL validation, fail-closed capability checks, external-task cancellation, terminal-task replacement, ffprobe-backed remote result authenticity, and the provider-neutral Avatar contract kit.
- Job service integration suite: 15 tests passed, including deferred external work being rescheduled beyond `maxAttempts` while preserving attempt history and eventual completion.
- Job service integration suite: 15/15 passed again against an isolated PostgreSQL schema on the running test service; the shared public database remains unsuitable because of the legacy migration history described below.
- The Digital Human API integration suite also verifies subtitle generation creates a `TEXT` Asset and that the stored subtitle can be downloaded through the project Asset route.
- Format check: passed (472 files).
- Lint check: passed (178 TypeScript files).
- `git diff --check`: passed.
- Root TypeScript typecheck and build pass, and the clean temporary-schema migration matrix passes 9/9. The shared `contentos_test` public database is not clean: its `schema_migrations` history still contains the old pre-renumbering `0031_digital_human.sql`/`0032_digital_human_billing.sql` entries, so the legacy database integration tests fail when the new `0038`/`0039` files attempt to create already-existing Digital Human tables. The database was not reset or its history rewritten.
- Web production build passed with Next.js 14.2.21, and `python -m py_compile tools/indextts-gateway/gateway.py` passed.
- Remote Avatar result validation unit tests: 17/17 passed.
- AvatarProvider contract tests: 2/2 passed.
- Digital Human complete suite after the result-validation and contract additions: 58/58 passed.
- Real browser acceptance against an isolated PostgreSQL schema with fake providers: 1/1 passed; this exercised web → API → DB → Job → Worker → Asset → Edit Manifest and the blocked/unavailable browser state.

## Runtime status

`F:\ContentOS-AI` now contains the official IndexTTS 2.5 checkout, Python 3.11.15 isolated environment, ModelScope checkpoints, auxiliary w2v/MaskGCT/CAMPPlus/BigVGAN models, and the official sample reference audio. Two direct GPU inferences passed; the loopback gateway passed live health, capability, and generation checks; and the repository `IndexTTS25SpeechProvider` passed a live capability + generation call against that gateway. The latest live run produced a 4,272.5 ms WAV on the direct gateway path and a 3,111.5 ms WAV through the ContentOS adapter. Measurements and exact runtime provenance are recorded in `F:\ContentOS-AI\INSTALL_REPORT.md`.

The HZAgent/cloud-avatar API portion is intentionally interface-only because no verifiable official schema or staging contract was supplied. The code keeps the `AvatarProvider` boundary and fake provider for deterministic tests, while the default `hzagent` runtime selection fails closed with an explicit unavailable state. No vendor-specific URL, credential, auth, request field, or response field mapping is claimed. The targeted TypeScript, Job, migration, Digital Human, and Web verification gates pass; the full baseline caveat remains limited to the pre-existing migration-history mismatch described above.

Latest runtime recheck on 2026-09-21 restarted the isolated gateway on `127.0.0.1:8788`: `/health` reported `modelLoaded=true`, `device=cuda:0`, `modelVersion=2.5`; `/capabilities` returned the expected IndexTTS 2.5 limits; a direct speech request produced a 3,192.7 ms WAV; and the ContentOS `IndexTTS25SpeechProvider` produced a 3,308.8 ms WAV with provider/model provenance. The temporary gateway was stopped after verification.
