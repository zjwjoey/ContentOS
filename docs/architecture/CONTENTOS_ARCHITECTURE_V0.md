# ContentOS Architecture V0

## Decision

ContentOS V0 is a **modular monolith control plane** with separately deployed Director, Video and Publisher worker processes. PostgreSQL is the durable source of truth; asset storage holds immutable media/artifacts; the queue delivers durable Job work but is not authoritative.

```text
                                  ContentOS
                                     |
                          Web UI + API / Control Plane
                                     |
   +-----------+-----------+----------+----------+-----------+----------+
   | Project   | Director  | Asset    | Video    | Publisher | Review   |
   +-----------+-----------+----------+----------+-----------+----------+
                   |             AI Module             |
                   +----------------+------------------+
                                    Job Module
                                     |
                             durable queue adapter
                   +-----------+-----------+-----------+
                   |                       |           |
              Video Worker       Publisher Worker  Director Worker
                   |                       |           |
                FFmpeg              Playwright      AI Providers
                   \                       /           /
                    PostgreSQL + Asset Storage
```

## Control Plane

Owns request authentication, Project lifecycle, module use-case orchestration, Job creation/dependency release, configuration reads, audit and query APIs. It must never execute FFmpeg, launch Chromium, manipulate platform pages or perform lengthy generation work in request handlers.

## Process responsibilities

| Process | Owns | Must not own |
|---|---|---|
| Web UI | user interaction and read models | domain mutations other than API calls; credentials; worker logic |
| API/Core | domain commands, persistence, Job orchestration | FFmpeg/Chromium/platform automation |
| Director Worker | claimed Director AI Jobs, provider calls, revision result reporting | Video/Publisher/Review execution; private tables |
| Video Worker | claimed render Job, staging, FFmpeg, artifact reporting | asset selection, Project lifecycle, publishing |
| Publisher Worker | claimed publish Job, account-session lease, Adapter execution | rendering, Director rules |

## Fixed V1 workflow

`Director -> Video -> Approval Gate -> Publish -> post-publish Review` is a set of explicit application use cases. Each phase may create several Jobs. V1 has no user-authored workflow graphs; dependencies are persisted Job dependency rows.

## Architectural fitness tests

- A new AI provider changes only AI provider registration/configuration, not Director use cases.
- A new platform changes only a Publisher Adapter and registration, not other adapters.
- A new renderer can consume the same Edit Manifest without changing Project, Director or Publisher.
- Worker loss cannot lose Job meaning because Job/attempt/artifact truth is in PostgreSQL/storage.
