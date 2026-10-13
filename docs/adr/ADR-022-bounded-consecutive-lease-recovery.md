# ADR-022: Bound consecutive lease-loss recovery

Status: Accepted with conditions for isolated implementation. The user explicitly authorized this policy on 2026-10-13; delegated technical review agreed on independent durable counters, owner transactions and a compensatable BLOCKED path. Integration remains subject to regressions and PR review; no main merge is authorized.

## Problem and decision

Ordinary expired leases currently requeue indefinitely. Using `attempt_count >= max_attempts` would terminate legitimate remote pending/defer jobs: execution history is not a crash count. A terminal Job without matching owner recovery can also leave its domain RUNNING or replay an uncertain external publish.

Add migration 0053 with a nonnegative `jobs.consecutive_lease_failures` defaulting to zero. The policy is prospective: preserve existing attempts, events and business data; no historical backfill or ADR-019 activation. Two consecutive losses may requeue; the third stops automatic execution. The limit is a fixed shared policy of three, not per-process memory or a second queue.

Current-attempt success, normal failure settlement, defer, cancellation and explicit terminal retry reset the streak. Claim, heartbeat and ordinary RETRY_WAIT requeue do not. `attempt_count` remains monotonic history. Existing business `fail()`/`maxAttempts` semantics are unchanged: that older budget still uses total attempts, including prior defer history; this ADR does not redefine business failure retries.

## Owner authority and recovery

Each production worker reconciles its explicit owned Job types. A published recovery callback receives the current Job, one short-lived Job-owned transaction scope, outcome RETRY_WAIT or FAILED, streak/limit and a safe error. The callback performs only owner database work through that executor, validates payload/Job/attempt linkage, preserves completed results and returns whether it can confirm the outcome. Providers and filesystem cleanup stay outside the transaction. Retry recovery restores resumable unfinished state where required; failure closes matching unfinished domain state, including aggregate/batch state that could otherwise spawn replacement Jobs outside the budget.

The existing reconciler locks and revalidates each Job and its current attempt. Owner recovery, attempt closure, streak, Job outcome and events commit atomically; a callback failure rolls back that Job and does not block other Jobs. The callback scope rejects transaction control, nested Job APIs, use after close and unawaited queries.

At exhaustion, a missing or refusing owner callback closes the expired attempt and puts the Job in BLOCKED with `LEASE_RECOVERY_OWNER_UNAVAILABLE`, streak three, and no lease/retry time. This prevents stale handlers and automatic claim without pretending the domain failed. The same reconciler also discovers only these exact BLOCKED records, locks and revalidates their failed current attempt, then asks the owner to finish recovery to FAILED. Repeat scans do not increase the streak or duplicate exhaustion events. BLOCKED is not directly manually requeued: owner repair precedes terminal retry.

Cancellation takes precedence and retains existing cancellation semantics. Confirmed successful domain output is never overwritten as failed. Digital Human recovery preserves external task identity; Publisher preserves uncertain outcomes for reconciliation/manual action and never blindly republishes. Manual terminal retry resets the streak and records its event in the same locked transaction while retaining all attempt history.

## Alternatives and validation conditions

Rejected: total attempt caps (defer incompatibility); process-local counters (lost on restart); indefinite expired RUNNING (old heartbeat/results remain authoritative); unconfirmed domain failure; event-tail inference (requires permanent events and a separate manual-retry history boundary).

Required tests: three losses stop, restart persistence, repeated defer and explicit retry reset, concurrent reconciliation/heartbeat fencing, callback rollback and poisoned-owner isolation, BLOCKED recovery, cancellation priority, scope safety, and real isolated PostgreSQL owner consistency. Provider doubles must include late results ignoring abort. Asset/Video/Analysis/Digital Human and Publisher recovery must preserve completed results, staged inputs, external identity and aggregate semantics. Run existing full, migration, Intelligence, Digital Human, Runtime and CI gates. All databases are isolated tests; no real publishing or paid calls.

Rollback: revert consumers and Job policy before migration down. Dropping only the new counter cannot reconstruct a stopped Job's previous active state; do not blindly reopen terminal/BLOCKED Jobs or erase history. Existing business rows need no data rewrite; any operator retry uses the published owner workflow.
