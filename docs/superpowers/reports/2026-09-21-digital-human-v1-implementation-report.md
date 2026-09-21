# Digital Human V1 Implementation Report

## Scope

The supplied `DIGITAL_HUMAN_V1_DESIGN.md` and isolated-development prompt were treated as project specifications. The user request is the delivery objective: complete the implementation in an isolated branch and push it to the remote repository.

## Implemented

- Independent provider contracts for speech, avatar, alignment, and provider media staging.
- IndexTTS 2.5 HTTP adapter and fake speech provider.
- Configurable remote avatar adapter and fake avatar provider.
- Synthetic sentence timing provider.
- PostgreSQL migration `0031_digital_human.sql` with Voice Profile, Avatar Profile/Clip, Speech Generation, and Avatar Generation tables.
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
- A named `HzAgentAvatarProvider` adapter now forms the vendor boundary; other remote providers continue to use the generic HTTP adapter.
- Built-in HMAC/TTL Provider Media Staging is available with `CONTENTOS_MEDIA_STAGING_PROVIDER=signed-url`; ContentOS serves only READY AUDIO/VIDEO Assets through a signed query URL and never exposes `STORAGE_ROOT` or persists the temporary URL.
- Remote avatar task adapters now preserve normalized status, model version, cost, and provider provenance; result downloads require HTTP(S) and honor Job cancellation signals.
- Job cancellation now persists Speech/Avatar generation `CANCELLED` state and invokes the optional remote avatar `cancelTask`, including the race window immediately after remote submission; a worker regression test covers external-task cancellation.
- Digital Human lease recovery now supplies a cancellation handler for expired `CANCEL_REQUESTED` Jobs, so a Worker loss cannot leave the Job stranded and an existing external Avatar task is cancelled during recovery.
- Failed or cancelled Speech/Avatar requests can be explicitly retried through dedicated API/UI actions; terminal local Jobs are requeued idempotently, and a prior remote Avatar task is replaced only after the provider reports `FAILED` or `CANCELLED`.
- Avatar preflight now requires positive source/audio durations, checks provider video/audio formats and maximum duration before staging or charging the remote provider, and completion writes are conditional on the Generation remaining active, preventing cancellation races from becoming false successes.
- Remote Avatar submissions carry the stable Generation request ID through a configurable idempotency header and request field, allowing a compatible provider to deduplicate the submit-after-uncertain-write recovery path.
- Durable Job execution now supports explicit deferred polling: an external Avatar task that remains `QUEUED`/`RUNNING` is rescheduled without consuming the Job's terminal retry budget, so long-running paid tasks do not become false failures after a fixed number of polls.
- Remote Avatar result downloads now have a separately configurable timeout (`CONTENTOS_AVATAR_RESULT_TIMEOUT_MS`) and abort/cleanup partial work when the timeout expires.
- HTTP Avatar adapters reject private or loopback result URLs before they cross into Worker download logic; Avatar Clip usage counters and `last_used_at` are updated only for the first idempotent generation request.
- Remote Avatar result downloads now stream directly to staging with a configurable byte limit (defaulting to the asset upload limit), reject oversized responses before Asset import, and clean partial files on failure.
- Configured remote Avatar providers now health-check the authenticated, configurable capabilities endpoint with a timeout; authentication or availability failures are surfaced before a paid generation Job is created.
- Speech, Avatar, and HTTP media-staging adapter requests now have configurable bounded timeouts (`CONTENTOS_PROVIDER_REQUEST_TIMEOUT_MS` / `CONTENTOS_PROVIDER_CAPABILITY_TIMEOUT_MS`) and normalize network/timeout failures as retryable provider outages.
- Provider Media Staging now rejects loopback, private-network, `.local`, and `.internal` base/result URLs; runtime capability readiness is false when the configured staging address cannot be publicly reached.
- The named HZAgent adapter is now configuration-driven for submit/task paths and authentication header/scheme, and accepts common camelCase/snake_case task response aliases without leaking vendor details into the service layer.
- Synthetic subtitle timeline export as Edit Manifest cues, SRT, and ASS through the Speech Generation API.
- SRT/ASS subtitle downloads now persist idempotent `TEXT` Assets with project ownership and expose the Asset content route, so subtitle files are traceable and reusable rather than transient response bodies.
- A real PostgreSQL temporary-schema Worker vertical slice now runs the durable `AVATAR_LIPSYNC_GENERATE` handler, fetches a remote result through the staging boundary, and imports it as a distinct READY project `VIDEO` Asset with duration metadata and provider task provenance.
- Speech completion now prefers the duration probed from the imported AUDIO Asset while retaining the provider-reported duration in provenance, so subtitle timing follows the stored media when both measurements are available.
- Worker preflight failures now transition the corresponding Speech/Avatar Generation to `FAILED` instead of leaving it `RUNNING`; API and Workspace cancellation controls request Job cancellation and persist Generation `CANCELLED`, while cancelling an existing remote Avatar task before local cancellation and preserving the Worker race-safe cancellation path.
- Capability endpoint at `/api/v1/projects/:projectId/digital-human/capabilities`, with the UI displaying live speech/avatar availability instead of assuming a provider is configured.
- Successful Avatar Generations can now create an idempotent `EDIT_MANIFEST_V0` plus the existing `VIDEO_RENDER` Job; the workspace redirects to the existing video editor, preserving generated speech, synthetic subtitle cues, 9:16 canvas, and FFmpeg rendering.
- Loopback IndexTTS gateway source at `tools/indextts-gateway/gateway.py` with input-root allowlisting, output-root isolation, request correlation logging, and `/health`, `/capabilities`, and `/v1/speech/generate` endpoints.
- Workspace UI actions for Voice Profile, Avatar Profile, Avatar Clip, speech generation, avatar generation, output preview, and subtitle download.
- Contract/provider/worker/config tests and a proposed ADR.

## Verification

- Targeted TypeScript compilation: passed.
- Digital Human/config/worker unit tests and provider contract checks: passed.
- Digital Human/API/provider suite: 24 tests passed, including the real PostgreSQL temporary-schema EditManifest/VIDEO_RENDER flow, the Worker-to-Asset vertical slice, probed Speech Asset duration, API cancellation with remote `cancelTask` invocation, lease-recovery cancellation, graceful shutdown waiting, Worker preflight failure recording, oversized-result and download-timeout protection, concurrent Speech/Avatar idempotency and retry checks, Clip usage accounting, signed staging, subtitle Asset persistence, authenticated capability health-checks, bounded provider request failures, private result URL rejection, public-staging URL validation, fail-closed capability checks, external-task cancellation, and terminal-task replacement.
- Job service integration suite: 15 tests passed, including deferred external work being rescheduled beyond `maxAttempts` while preserving attempt history and eventual completion.
- The Digital Human API integration suite also verifies subtitle generation creates a `TEXT` Asset and that the stored subtitle can be downloaded through the project Asset route.
- Format check: passed (469 files).
- Lint check: passed (177 TypeScript files).
- `git diff --check`: passed.
- Full TypeScript baseline: passed after restoring the workspace dependency links with the lockfile's `autoInstallPeers=false` setting.
- Full baseline test run: the previously verified direct run recorded 280 passed / 3 failed when pointed at the configured PostgreSQL test service on port `55433`. All remaining failures are shared test-database migration-history issues: that database still records the pre-existing `0037_script_editing_v3_settings` migration, whose down file is not present in this branch. The clean temporary-schema migration matrix passes 9/9, and the current Digital Human test suite passes 21/21.
- Root TypeScript build, Web production build, format, lint, typecheck, and `git diff --check` pass on the current worktree. The Web build was run directly from `apps/web` because the isolated worktree's root `node_modules` is a junction to the original repository and pnpm 11 refuses that junction for task-state storage.

## Runtime status

`F:\ContentOS-AI` now contains the official IndexTTS 2.5 checkout, Python 3.11.15 isolated environment, ModelScope checkpoints, auxiliary w2v/MaskGCT/CAMPPlus/BigVGAN models, and the official sample reference audio. Two direct GPU inferences passed; the loopback gateway passed health, capability, and generation smoke checks; and the repository `IndexTTS25SpeechProvider` passed a live capability + generation call against that gateway. Measurements and exact runtime provenance are recorded in `F:\ContentOS-AI\INSTALL_REPORT.md`.

The real HZAgent avatar request is not claimed as complete because no API credential, staging service, or verifiable official HZAgent API schema was supplied. The avatar provider remains fail-closed until those external prerequisites are configured; the code does not invent a vendor-specific field mapping. Full TypeScript baseline and PostgreSQL integration tests also remain blocked by the pre-existing dependency/database environment issues documented above.
