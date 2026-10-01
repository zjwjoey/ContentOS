# ContentOS V1 Integration Scope

状态：`IMPLEMENTED`

## Included from Desktop V1

- Runtime Core, Runtime Client, Runtime Host, lifecycle, single-instance,
  restart/shutdown, state persistence, dynamic ports, and diagnostics.
- Electron shell, Embedded PostgreSQL, FFmpeg/FFprobe staging, packaging,
  installer/portable smoke, clean-Windows foundation, and Windows CI jobs.

## Included from Intelligent Editing V1.5

- Analysis, planning, decision routes, `media-intelligence-worker`, contracts,
  `EDIT_MANIFEST_V0` integration, transactional candidate replacement, Web
  navigation/page, and migrations `0047`–`0052`.

## Desktop ancestry deliberately excluded

- Digital Human workbench, duration policy, HZAgent provider behavior, and the
  `0047_digital_human_duration.sql` forward migration.
- Shared UI localization is not treated as a Desktop runtime dependency; only
  the project-navigation changes necessary to retain Intelligence are merged.

## Shared resolution

- API and workers remain Electron-free.
- API, workers, and Desktop use one `DATABASE_URL` / Embedded PostgreSQL cluster.
- Packaged Intelligence paths are under Desktop userData.
- `media-intelligence-worker` is optional and Safe Mode excludes it.
- Production packaged mode does not default to Fake Intelligence; Fake is a
  test-mode capability.
