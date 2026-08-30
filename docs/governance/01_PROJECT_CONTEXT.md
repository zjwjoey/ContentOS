# ContentOS Project Context

> Status basis: 2026-08-27. This file describes repository reality; it is not a promise that side-branch work is already integrated.

## Purpose

ContentOS is a modular short-video production and operations system. Its primary traceability unit is a `ContentProject` that connects creative intent, media, rendering, approval, publishing and post-publish learning.

```text
Content Project
  -> Director
  -> Video
  -> Human Approval
  -> Publisher
  -> Metrics / Review Analytics
  -> Feedback to Director
```

ContentOS is not a generic workflow builder and not a full non-linear video editor.

## Repository reality

`main` contains the stable V0 foundation and the previously integrated Director foundation, Director-to-Video bridge, Fake Publisher and Human Review work. The current development lines are separate:

| Line                                     | Current meaning                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `main`                                   | Stable integrated baseline (`752e8c4` at the time of writing)                                                  |
| `codex/project-center`                   | Project Center implementation and final reliability repairs; this working tree may contain uncommitted changes |
| `codex/director-v1`                      | Director V1, AI Provider abstraction, provenance and operator UI                                               |
| `feature/slice-5-real-platform-adapters` | Real-platform adapter implementation and safety hardening; live smoke remains separately gated                 |
| `codex/publisher-project-integration`    | Publisher-to-Content-Project integration line                                                                  |
| `codex/publisher-productization`         | Earlier Publisher Fake product slice                                                                           |

These lines must not be described as one integrated product until a combined branch has merged them and passed the combined gate.

## Product maturity

| Area                                     | Current status                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| Architecture V0                          | Frozen and mature                                                                       |
| PostgreSQL, migrations, Jobs and Workers | Mature foundation                                                                       |
| Asset management                         | Functional with atomic content-addressed promotion                                      |
| Director foundation                      | Integrated; Director V1 remains branch-scoped until convergence                         |
| Video engine                             | Functional deterministic planning and FFmpeg rendering                                  |
| Publisher Fake                           | Functional and covered by automated tests                                               |
| Real platform adapters                   | Implemented on a separate branch; live verification is opt-in and not implied           |
| Human Review                             | Functional for approval decisions                                                       |
| Project Center                           | Implemented on `codex/project-center`; integration status depends on branch convergence |
| Review Analytics                         | V1 implemented for Fake/Import metrics; real platform metrics deferred                  |
| Unified product                          | Not complete until one integrated branch demonstrates the required path                 |

## Non-negotiable decisions

- PostgreSQL is durable business truth; queue delivery rows are not the domain state.
- Long-running work travels through durable Jobs and independent Workers.
- Video execution consumes an immutable, validated `EDIT_MANIFEST_V0`.
- Renderer code executes approved intent and does not invent creative choices.
- Publisher behavior is platform-neutral in the core and platform-specific inside adapters.
- Credentials, cookies, authorization headers and tokens never enter ordinary logs, snapshots or Job payloads.
- Unknown external publish outcomes enter reconciliation; they are never blindly retried.
- Historical revisions and review decisions remain append-only where the contract requires it.

## Current priority

The next major engineering goal is integration closure: converge the existing branches, reconcile migration numbering and prove the combined Project → Director → Video → Review → Publisher path. Review Analytics V1 is limited to Fake/Import observations; real platform breadth and speculative workflow abstractions remain gated.
