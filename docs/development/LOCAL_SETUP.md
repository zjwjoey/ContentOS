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
4. Start the Video Worker and Publisher Worker as separate processes when their composition roots are wired for an environment.

The current initialization includes a local-only Asset provider and a real FFmpeg vertical-slice test. It intentionally does not include platform adapters, real AI providers, Director, Review or a production Web UI.
