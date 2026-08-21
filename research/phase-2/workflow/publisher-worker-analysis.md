# Publisher Worker: Matrix vs douyin-web

## Evidence

**matrix**: `publish_video_queue.py` is an infinite polling loop over MySQL `mx_publish_task_video_queue`, changes status in SQL, validates cookies with a fresh Playwright context, then branches directly across platform upload implementations. `douyin_uploader/main.py` writes Playwright `storage_state` to files and uses Redis keys for QR/login status.

**douyin-web**: `app.py` persists accounts, tasks and per-account jobs; `db.py` defines `accounts`, `publish_tasks` and `publish_jobs`. Its `run_publish_queue` runs tasks with an `asyncio.Semaphore`, updates current steps/status and uses `DouyinBrowserManager`. `browser.py` keeps active interactive login sessions in memory and cleans them in FastAPI lifespan shutdown.

## Comparison

| Question | matrix | douyin-web | ContentOS decision |
|---|---|---|---|
| Unit of work | Polling DB row | Task + per-account job | `PublishAttempt` per account/platform under a durable `PublishJob` |
| Platform isolation | Direct branches in one loop | Single platform manager | Adapter owns platform logic; worker owns generic claim/retry/reporting |
| Browser/session | Per-operation context plus file storage state | Manager-held contexts + persisted cookie record | Browser context belongs to one account-session lease; credential record is encrypted and durable |
| Concurrency | Implicit sequential loop | In-process semaphore | Broker worker concurrency + per-adapter/per-account limits |
| Recovery | Status mutation and polling | DB status but background coroutine dies with API process | Durable lease/heartbeat/retry state outside API process |

## Worker topology decision

Use **one Publisher Worker process type handling many adapters**, not permanent `Douyin Worker`, `Wechat Worker`, `XHS Worker` services. The job specifies `adapter_key`; the worker loads the adapter and enforces adapter/account concurrency limits. Split a platform into its own deployment only when its browser footprint, rate limit, security isolation or operational volume proves it necessary. This retains common job semantics and avoids deployment sprawl.

## Error feedback contract

- Expired login, SMS/captcha, and human-verification are non-retriable automatic outcomes: `BLOCKED` with `action_required=reauthenticate`; preserve sanitized diagnostic screenshot/log metadata.
- Navigation/selectors/platform-change/timeouts/network errors are retryable only under an adapter-declared policy with jitter and capped attempts.
- Browser crash maps to retryable infrastructure failure after session cleanup; persistent context corruption maps to `BLOCKED` and creates a new login session.
