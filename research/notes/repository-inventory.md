# Phase 1 Repository Inventory

Retrieved 2026-08-21. SHAs are immutable references used by this research pass.

| Project | Repository | Branch | Commit SHA | License | Main languages | Primary framework/runtime | Access |
|---|---|---|---|---|---|---|---|
| MatrixMedia | `hanliang97/MatrixMedia` | main | `a28e73b9d7c23823f9b18acb6e6086a62dd852d5` | GPL-2.0-only | JavaScript, Vue | Electron + Vue 2 + Puppeteer | Shallow clone complete |
| AI Short Video Factory | `YILS-LIN/short-video-factory` | main | `8f83bf320c69f4a81ba017fb9871e255679cd275` | AGPL-3.0 | TypeScript, Vue | Electron + Vue 3 + FFmpeg | Shallow clone complete |
| MoneyPrinterTurbo | `harry0703/MoneyPrinterTurbo` | main | `8d0e188ea84539d4fcf7dcff5c16b4ab3f2c4c6d` | MIT | Python | FastAPI + Streamlit + MoviePy/FFmpeg | GitHub API/raw source verified; shallow clone interrupted by execution cap |
| AutoSocial | `Katzca/AutoSocial` | main | `6deb560ee58ea1e6a040e1ee8e6ca269bd1576b5` | MIT | JavaScript | Node.js + Express + node-cron | Shallow clone complete |
| Postiz | `gitroomhq/postiz-app` | main | `74b01ada154a177242d558bedc646fcfed100adf` | AGPL-3.0 | TypeScript | pnpm monorepo + Next.js + NestJS + Temporal | Shallow clone complete |

## Retrieval notes

- The `MoneyPrinterTurbo` repository contains a large resource footprint. Two interrupted clone directories are retained as diagnostic remnants; they contain no completed worktree and were not used as research evidence.
- Its remote SHA was checked with `git ls-remote`; repository tree and selected `app/` source were fetched read-only through GitHub’s API/raw endpoints. No repository code was run.
