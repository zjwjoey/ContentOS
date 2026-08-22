# ContentOS Local Setup (Windows)

## Prerequisites

- Node.js 22 LTS target (the current validation host reports Node 24.14.0).
- pnpm 10.32.1.
- PostgreSQL 16 development server. The local cluster used by this workspace is `127.0.0.1:55433`.
- Use separate databases for operator preview (`contentos_operator_dev`) and automated tests (`contentos_test`).
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

Set `DATABASE_URL` and `STORAGE_ROOT` before starting the API. For the one-command Director preview, set `CONTENTOS_OPERATOR_DATABASE_URL` and run `pnpm dev:operator`; the launcher defaults to `contentos_operator_dev`. For tests, set `DATABASE_URL` to `contentos_test`. `.env.example` contains the non-secret shape; never commit `.env` or credentials.

## Development order

1. Start PostgreSQL and confirm port `55433` is reachable.
2. Create or select the `contentos_operator_dev` and `contentos_test` databases.
3. Run `pnpm dev:operator` for the API, Web and Fake AI Director Worker.
4. Run `pnpm test` with `DATABASE_URL` pointing at `contentos_test`.
5. Start the Video Worker and Publisher Worker as separate processes when their composition roots are wired for an environment.

The local Operator uses the Fake AI Provider only. It intentionally does not include platform adapters, real AI providers, real credentials or external platform calls.
