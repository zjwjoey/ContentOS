# Module Inventory

Initial filesystem/API/contract inventory; table families below are ownership candidates to verify against service SQL, not a completed table-access audit. No module move is authorized by this document.

| Area | Implementation location | Responsibility / representative records | Inspection level |
| --- | --- | --- | --- |
| Project | packages/modules/project | Content projects, project associations | Entry discovered |
| Job | packages/modules/job | Durable jobs, attempts, dependencies, events, leases | Creation and recovery method locations inspected |
| Asset | packages/modules/asset | Assets, imports, local media indexing | Entry discovered |
| Director | packages/modules/director | Briefs, script/storyboard/plan revisions, orchestration | Entry discovered |
| AI | packages/modules/ai | Provider contract, prompt versions, AI provenance | Contract and README discovered/read |
| Video | packages/modules/video | Workspaces, manifests, renders, editing plans/batches | Service excerpt and contracts discovered |
| Intelligence | packages/modules/intelligence | Analysis runs, shots, ASR, embeddings, edit plans/decisions | Entries and migration families discovered |
| Digital Human | packages/modules/digital-human | Avatar generation, providers, remote media | Entry discovered |
| Production Run | packages/modules/production-run | Pipeline stage orchestration | Service excerpt inspected |
| Publisher | packages/modules/publisher | Accounts, requests/revisions, attempts, external posts, adapters | README read; contract/adapter locations discovered |
| Approval | packages/modules/approval | Pre-publication decisions | Entry discovered |
| Review | packages/modules/review | Post-publication metrics and reports | README read; service entries discovered |
| Benchmark | packages/modules/benchmark | Accounts, content analyses, references | Entry discovered |
| Local Path | packages/modules/local-path | Native picker and path grants | Entry discovered |
| Database | packages/database + migrations | Migration loading and DB client | Loader and matrix read |
| Contracts | packages/contracts + packages/desktop-contract | Published application and desktop schemas | Files enumerated |
| Infrastructure | packages/infrastructure | Queue delivery, storage, renderer and provider integration | Paths enumerated |
| Runtime | packages/runtime-core + packages/runtime-client | Process lifecycle, instance/port guards, PostgreSQL manager | Paths enumerated |
| Applications | apps/api, apps/web, apps/cli, apps/desktop | API composition, UI, launch, Electron shell | Package/entry inventory; API excerpt |
| Workers | workers/* | Asset, benchmark, director, video, publisher, review, digital-human, media-intelligence | Package and entry inventory |

Several module READMEs still say “Reserved” despite existing service files (Project, Job, Asset, Video, Director). Those README statements must not be used as feature absence evidence. Workspace globs cover apps/*, workers/*, packages/* and packages/modules/*; frozen install reports 19 package projects, which is not the number of logical modules. Full ownership mapping, test coverage attribution and runtime call graph remain pending.
