# Architecture Change Requests

## Spike 01

**Current Decision:** PostgreSQL is the Job source of truth; pg-boss is the delivery queue.

**Observed Problem:** A killed worker can leave a pg-boss row active until queue maintenance runs, while the durable Job record remains `RUNNING`.

**Evidence:** `SPIKE_01_JOB_WORKER_REPORT.md`; the crash scenario required a database lease reconciler to transition the expired Job to `RETRY_WAIT` and re-deliver it.

**Recommended Change:** Clarify the Worker Architecture contract: every worker process must reconcile expired Job leases from PostgreSQL and re-enqueue recoverable work. pg-boss supervisor settings are supporting maintenance, not the only recovery authority.

**Impact:** Adds a small maintenance loop and observability requirement; does not change the modular monolith, PostgreSQL, persistent Job or independent-worker decisions.

**Decision status:** Pending human architecture review; no blocking redesign requested.

## Spike 04

**Current Decision:** Publisher automation is isolated inside a Worker with one browser context/profile directory per account.

**Observed Problem:** A fake Playwright-shaped browser can verify control flow, but it cannot prove compatibility with a real provider DOM or browser binary.

**Evidence:** `SPIKE_04_PUBLISHER_WORKER_REPORT.md`; six passing tests cover success, auth, verification, DOM drift, browser/worker crash, profile isolation and redaction.

**Recommended Change:** Keep the fake-platform contract as the default unit-test boundary, then add a separately authorized provider smoke test with pinned Playwright/browser versions and sandbox credentials before engineering initialization.

**Impact:** Adds a gated integration-test requirement; preserves independent workers and the no-real-platform rule for disposable spikes.

**Decision status:** Pending human architecture review; no blocking redesign requested.

## Spike 03

**Current Decision:** Asset identity is SHA-256 content-addressed; staging and promotion are separate states.

**Observed Problem:** Local same-filesystem atomic rename is reliable, but remote object stores do not provide identical rename or crash semantics.

**Evidence:** `SPIKE_03_ASSET_PROMOTION_REPORT.md`; five passing tests covering dedupe, Unicode metadata, checksum mismatch, crash-window cleanup and atomic success.

**Recommended Change:** Keep the checksum/staging/promotion contract, add stale-temp reconciliation, and require a provider-specific conditional-create/commit protocol before choosing an object store.

**Impact:** Adds storage-adapter and cleanup requirements; no change to the ContentOS module boundaries.

**Decision status:** Pending human architecture review; no blocking redesign requested.

## Spike 02

**Current Decision:** `EDIT_MANIFEST_V0` is the renderer input boundary; FFmpeg is invoked by a thin deterministic builder.

**Observed Problem:** The available Windows PATH FFmpeg is a legacy 2014 build with libass/fontconfig warnings and no `fontsdir` option, so a plain `subtitles` filter can succeed without visible Chinese text.

**Evidence:** `SPIKE_02_VIDEO_RENDER_REPORT.md`; five real seeded outputs; extracted frames at 7s and 17s show Chinese subtitles using `C:\Windows\Fonts\msyh.ttc`.

**Recommended Change:** Pin a supported FFmpeg distribution and make font/codec capability checks explicit. Keep the explicit-font fallback or equivalent deterministic subtitle path, and fail with structured diagnostics when the required font is unavailable.

**Impact:** Adds runtime packaging and startup validation requirements; does not change the Manifest boundary or modular-monolith decisions.

**Decision status:** Pending human architecture review; no blocking redesign requested.
