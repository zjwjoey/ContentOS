# ContentOS Script Editing V2 Implementation Report

## Git

- Base SHA: `f318da93be6724fed87822c1ce9de5fe19ffb4a8`
- Branch: `codex/script-editing-v2-rule-editorial-layer`
- Implementation commits: `fab92e6`, `1e30c1f`, `76717b0`, `a665e6d`, `942730e`
- Final integrity/picker commits: `1336efc`, `2ccab8c`, `0410773`, `6193911`
- `origin/main`: `42c9b2f1eb80fddf63bef67dd8932ec448cabcd9`
- No merge or automatic PR was created.

## Features

- Deterministic `EditorialPlanV1`/`ResolvedEditorialPlanV1` with template configuration, narrative roles, voice timing, scene timing conservation and 1–3 clip slots.
- Local/Pexels-compatible media resolution, entity protection, priority assets, controlled reuse, lock/reroll, and exact Preview → Manifest compilation.
- Sentence subtitles with stable Chinese wrapping, style metadata, Hero Text, local BGM selection/loop/trim and stable voice ducking.
- Durable `EDIT_SCRIPT_PLAN` job, PostgreSQL 0029 plan record, revision/status persistence, immutable manifest render snapshot and V2 Scene Card UI.
- V2 history summaries and copy-as-new-plan flow; existing VideoEditPreset branding assets are resolved into Intro/Outro timeline clips; missing local BGM produces a user-visible warning and continues without music.
- Workspace-scoped local-media and external-media thumbnails are persisted/exposed to Scene Cards; the web app proxies V2 plan requests to the API. Authorized output roots are validated and rendered files are copied atomically to a deterministic output path. The browser flow covers plan creation, lock/reroll, Hybrid provenance, local BGM, output-file delivery, external thumbnail delivery, render completion and Chinese history wording. Subtitle-bearing manifests fail explicitly when no usable font is configured instead of silently rendering without text.
- The FFmpeg fixture matrix covers the ten required render combinations: video-only, voice, subtitles, BGM, ducking, Hero Text, intro/content/outro, multi-clip scenes, 30fps and vertical 9:16.
- Existing V1/MIX manifest and renderer paths remain compatible.

## Verification

- `pnpm typecheck`: pass.
- `pnpm lint`: pass (156 TypeScript files).
- `pnpm format`: pass (432 files).
- `pnpm build`: pass.
- `pnpm --dir apps/web build`: pass (Next.js production build).
- `pnpm test`: 271/271 pass on a fresh isolated PostgreSQL 16 instance.
- `pnpm test:auto-edit-v1`: 27/27 pass on an isolated schema; `pnpm test:auto-edit-v15`: 19/19 pass on an isolated schema.
- `pnpm test:script-edit-v2`: 9/9 pass, including the ten-case FFmpeg fixture matrix; `pnpm test:migrations`: 9/9 pass.
- Browser operator suite: 4/4 pass, including V2 local/hybrid/reroll/BGM/history, output-file delivery, external thumbnail delivery and the Hybrid Script Editing source-controls flow.
- `pnpm doctor`: all checks pass with one pre-existing PATH warning for pnpm's global bin directory.
- Real Pexels is never used by tests; FakeExternalVideoProvider is used instead.

## Known limitations after final gate

- `pnpm doctor` reports one pre-existing warning because pnpm's global bin directory is not on PATH; all doctor connectivity and runtime checks pass.
- Real Pexels is never used by tests; the external-media flow uses the deterministic FakeExternalVideoProvider. Logo overlay remains an optional P2 enhancement; existing Intro/Outro branding assets are supported.

## Final Integrity Closure + Native Full-Computer Path Picker (current continuation)

- Entity integrity is enforced at resolver and manifest layers: `AUTHENTIC_ENTITY` requires exact entity equality; non-authentic matches are explicitly marked `entityFallback` with `NEUTRAL_BROLL` or `PLACE_CONTEXT`.
- Duration integrity is a hard resolver constraint for local, Pexels/Fake Pexels, priority and `MUST_USE` assets; short assets fail before planning.
- Absolute voice timing is preserved through visual gaps, intro offsets, subtitles, Hero Text and manifest metadata (`audioOffsetMs`); FFmpeg pads visual gaps instead of collapsing them.
- Reroll is now queued as a durable `EDIT_SCRIPT_PLAN` worker job and re-enters the resolver constraints; the API no longer mutates a resolved plan synchronously.
- Native local path selection is available through Windows Shell dialogs for media roots, output roots, voice/music files and priority assets. Canonical persisted grants are stored by migration `0030`, support folder children and exact files, and retain environment roots as deployment fallback. Picker cancellation returns `{ cancelled: true }`.
- V1, MIX and workbench forms expose the same picker path while retaining manual paths as an advanced fallback; picked media is scanned immediately.

Current continuation verification: `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm build`, `pnpm --dir apps/web build`, `pnpm test:script-edit-v2` (18/18), `pnpm test:migrations` (9/9), `pnpm test:auto-edit-v1` (27/27), `pnpm test:auto-edit-v15` (19/19), `pnpm test` (275/275), and browser acceptance (4/4) pass on PostgreSQL 16 at `127.0.0.1:55433` with isolated schemas. The Windows Shell picker process was successfully invoked from the running local operator; unattended acceptance deliberately did not select or transmit a user file, while picker cancellation is covered by the route test.

`pnpm doctor` reports the pre-existing pnpm global-bin PATH warning and a registry-connectivity failure in this environment; local version, cache, filesystem and offline install checks pass.

## GO / NO-GO

NO-GO for final release sign-off only until a user performs the final interactive Windows picker acceptance (select a real media folder, output folder, voice/music file and priority asset, then verify cancel). All automated integrity, migration, FFmpeg, full-suite, browser and build gates are green and the implementation is pushed; this remaining hold is manual acceptance, not an uncommitted-code hold.
