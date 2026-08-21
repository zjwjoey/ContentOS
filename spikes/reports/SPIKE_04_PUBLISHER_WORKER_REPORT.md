# Spike 04 Publisher Worker / Browser Isolation Report

## Result

**PASS WITH CONDITIONS**

The fake-platform publisher worker passed all required control-flow and isolation scenarios without touching a real platform, account or credential. The result is conditional because this spike uses a local Playwright-shaped fake browser; real Playwright version/browser launch and one provider adapter remain follow-up validation work.

## Scenario results

| Scenario | Result | Evidence |
|---|---|---|
| Fake-platform success | PASS | One local fake publication reached `SUCCEEDED` |
| Authentication failure | PASS | Wrong token returned `AUTH_REQUIRED`; no publish side effect |
| Verification challenge | PASS | Profile challenge returned `VERIFICATION_REQUIRED` |
| DOM change | PASS | Expected DOM version mismatch returned `DOM_CHANGED` before publish |
| Browser crash | PASS | Simulated page crash returned `BROWSER_CRASH`; no false success |
| Worker crash / retry | PASS | Durable JSON job state remained `RUNNING`; retry completed exactly once |
| Profile isolation | PASS | `alpha` and `beta` have separate contexts/profile directories and cookies |
| Log redaction | PASS | Tokens/password-like values are replaced with `[REDACTED]` |

## Environment and safety boundary

- Windows local host; Node.js 24.14.0 / npm 11.9.0.
- Local in-memory `FakePlatform`; Playwright-shaped page/browser calls only.
- No real browser launch, network request, publishing platform, account or credential.
- Evidence: `SPIKE_04_TEST_OUTPUT.txt`, `SPIKE_04_RUN_SUMMARY.json`, `SPIKE_04_ENV.json`.

## Findings

1. Publisher jobs need structured terminal outcomes for auth, verification, DOM drift and browser failures; generic “failed” is insufficient for retry policy and operator action.
2. Browser context and profile directory must be allocated per account/profile and never shared between concurrent jobs.
3. Worker crash recovery needs a durable Job state independent of browser state; a retry must be able to re-open an isolated context and avoid a duplicate successful side effect.
4. Redaction belongs at the logging boundary and must cover tokens, passwords, secrets and cookies before persistence or export.

## Architecture V0 change request

- Keep publisher adapters behind the Worker contract and require explicit outcome codes (`AUTH_REQUIRED`, `VERIFICATION_REQUIRED`, `DOM_CHANGED`, `BROWSER_CRASH`).
- Require one browser context/profile directory per account and a cleanup policy for abandoned contexts.
- Before production initialization, run a provider-specific Playwright smoke test using test credentials in a sandbox and pin the browser/runtime versions.
- Keep Fake Platform as the unit-test default; real platform access is an opt-in integration test only.

## Decision

The V0 publisher-worker isolation boundary is **PASS WITH CONDITIONS**. No critical blocker was found in the control-plane behavior; real Playwright/provider validation remains a gated follow-up. No formal ContentOS product code was created.
