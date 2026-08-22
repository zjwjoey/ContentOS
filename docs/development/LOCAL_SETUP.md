# ContentOS Local Setup (Windows)

## Prerequisites

- Node.js 22 LTS target (the current validation host reports Node 24.14.0).
- pnpm 10.32.1.
- PostgreSQL 16 development server. The initialized local cluster uses `127.0.0.1:55432` and database `contentos_dev`.
- FFmpeg and FFprobe on `PATH`, with `drawtext`, `scale`, `crop`, `concat`, `mpeg4` and `aac` capabilities.
- Chinese font file at `C:\Windows\Fonts\msyh.ttc` or an explicit `FFMPEG_FONT_FILE`.

## Install and verify

```powershell
pnpm install
pnpm run format
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
pnpm run doctor
```

Set `DATABASE_URL` and `STORAGE_ROOT` before starting the API. `.env.example` contains the non-secret shape; never commit `.env` or credentials.

## Development order

1. Start PostgreSQL and confirm port `55432` is reachable.
2. Run migrations through the database package before using API/workers.
3. Start API with `pnpm dev`.
4. Start the Video Worker and Publisher Worker as separate processes. The Publisher Worker registers Fake, Douyin OpenAPI and WeChat Channels adapters only through explicit composition-root configuration. Its executable refuses to start with a no-op handler: provide a durable Publisher state store, credential provider and Review approval provider.

The normal test suite uses fake HTTP/browser ports and never contacts a real platform. For an account-authorized manual smoke test, set the required local environment values and run an explicit command such as:

```powershell
$env:CONTENTOS_REAL_PLATFORM_SMOKE='1'
$env:CONTENTOS_PUBLISHER_REVIEW_APPROVED='1'
$env:CONTENTOS_PUBLISHER_ALLOW_SUBMIT='1'
$env:CONTENTOS_CREDENTIAL_DOUYIN='{"accessToken":"...","openId":"..."}'
pnpm publisher:smoke --platform douyin --account smoke-account --media E:\\ContentOS\\storage\\smoke.mp4 --credential-ref env://CONTENTOS_CREDENTIAL_DOUYIN --profile-root E:\\ContentOS\\storage\\publisher-profiles
```

For WeChat Channels, use a headed browser/profile and complete login or verification manually. Keep profiles and evidence outside source control (the local defaults `storage/publisher-profiles/` and `artifacts/publisher/` are ignored). A browser challenge, selector change or uncertain submit is returned as a normalized human-action/reconciliation result; the worker never bypasses it.
