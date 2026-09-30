# Desktop Runtime Third-Party Notices

This file records the pinned runtime components staged into the Windows x64
desktop artifact. The installer and portable executable must ship the
corresponding upstream notices and license texts when distributed externally.

| Component | Pinned package / runtime | Source | License note |
| --- | --- | --- | --- |
| Electron | `44.5.0` | Electron distribution | Electron license; see the upstream Electron notices bundled with the distribution |
| PostgreSQL | `18.4` from `@embedded-postgres/windows-x64@18.4.0-beta.17` | `leinelissen/embedded-postgres` package and its upstream native PostgreSQL distribution | The JavaScript/native package wrapper is MIT; PostgreSQL server binaries carry PostgreSQL's upstream license and notices |
| FFmpeg | `6.1.1-essentials_build-www.gyan.dev` from `ffmpeg-static@5.3.0` | pinned `ffmpeg-static` Windows x64 binary | The npm wrapper is GPL-3.0-or-later; the binary build's FFmpeg license and any codec obligations apply |
| FFprobe | `4.0.2` from `ffprobe-static@3.1.0` | pinned `ffprobe-static` Windows x64 binary | The npm wrapper is MIT; FFprobe follows the FFmpeg project license and the binary build's notices |

The exact staged versions and SHA256 values are generated in
`apps/desktop/resources/runtime-manifest.json` and verified by
`desktop:doctor`. Runtime startup never downloads or replaces these files.

Before a public release, the release owner must review the binary-specific
license files from the pinned upstream archives and include any required source
offer, attribution, or codec notices in the release bundle.
