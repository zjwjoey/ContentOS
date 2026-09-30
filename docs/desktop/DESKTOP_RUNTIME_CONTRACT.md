# Desktop Runtime Contract

## Stable concepts

Desktop code consumes the existing `RuntimeClient` and `RuntimeStatus` contracts.
The desktop-specific contract adds a narrow presentation model and commands:

```ts
type DesktopRuntimePhase =
  | 'STOPPED' | 'STARTING' | 'READY' | 'READY_WITH_WARNINGS'
  | 'DEGRADED' | 'FAILED' | 'STOPPING';

type DesktopRuntimeSnapshot = {
  phase: DesktopRuntimePhase;
  status: RuntimeStatus | null;
  lastError: { code: string; message: string; at: string } | null;
  logRoot: string;
};

type DesktopRuntimeCommand =
  | { type: 'start'; safeMode?: boolean }
  | { type: 'stop' }
  | { type: 'restart' }
  | { type: 'restart-service'; serviceId: string }
  | { type: 'doctor' };
```

The actual TypeScript source is the single source of truth; this document describes
the compatibility promise for the renderer and future update clients.

## IPC rules

- Channel names are constants, not user-provided strings.
- Every mutating command is serialized by the main-process Runtime Manager.
- Service IDs are validated against the returned registry before restart.
- Errors are plain serializable values with `code`, `message`, and optional details;
  stack traces and secrets never cross the boundary.
- Status subscriptions are push-only snapshots and are throttled to avoid renderer
  event storms.

## Compatibility

The Desktop API is versioned independently from the Runtime protocol. A mismatch is
reported as a diagnostic and blocks startup rather than loading a partially compatible
renderer. Runtime protocol remains `contentos-runtime` version 1.
