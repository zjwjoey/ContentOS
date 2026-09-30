# Desktop Packaging Plan

## Targets

- Windows x64 installer: `ContentOS Setup.exe`
- Windows x64 portable executable: `ContentOS.exe`

## Required staged contents

The packager must include Electron main/preload/renderer assets, compiled Runtime
Host and Runtime Client dependencies, production Next output, worker entrypoints, and
the production Node dependency tree required by packaged Runtime mode. It must never
depend on a developer checkout, global `pnpm`, or a source-only `tsx` runner.
The staged app also includes the repository `migrations/` directory and the Web
package manifest; Runtime Host uses those paths for its migration gate and `next start`.

## Packaging gates

1. `desktop:doctor` validates the staged layout and reports missing files.
2. `desktop:build` compiles TypeScript and the renderer assets.
3. `desktop:package` produces both installer and portable targets when the configured
   Windows packager is available.
4. A smoke test starts the packaged app, verifies the Runtime identity and readiness,
   opens the local Web URL, then shuts down cleanly.

If a Windows packager is unavailable on the development machine, the result is
`IMPLEMENTED` and `TESTED_ON_DEV_MACHINE` only; it must not be reported as
`PACKAGED` or `CLEAN_WINDOWS_TESTED`.
