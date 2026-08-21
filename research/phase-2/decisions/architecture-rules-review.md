# Architecture Rules Review

| Rule | Decision | Evidence and refinement |
|---|---|---|
| RULE-001 Content Project is central | Agree | Project ID correlates planning, asset, jobs, render and posts; Postiz’s organization/post correlation and n8n execution persistence support a stable root identity. |
| RULE-002 all time-consuming operations are Jobs | Modify | Make operations asynchronous when they may outlive an HTTP request or need retry/audit/cancel. Do not turn trivial reads/validation into Jobs. |
| RULE-003 Planner and Renderer separate | Agree | OpenShorts validates a transport split; its in-memory job map shows why ContentOS must persist the handoff. |
| RULE-004 Renderer only executes Manifest | Agree | V0 renderer receives an immutable manifest and rejects unsupported features; no hidden material selection. |
| RULE-005 Publisher uses Adapter | Agree | Postiz’s `SocialAbstract` and matrix’s painful direct branches demonstrate the boundary. |
| RULE-006 Publisher Worker and Video Worker separate | Agree | Browser/Chromium and FFmpeg have different crash, CPU/memory and concurrency behavior. |
| RULE-007 AI Model through Provider | Agree | Open WebUI transport adapters and AnythingLLM provider families support this isolation. |
| RULE-008 Prompt versioned | Agree | Required for render/review traceability; preserve key/version/hash for every AI job. |
| RULE-009 modules do not touch other modules’ internals | Modify | Modules communicate through published use-case interfaces/events and owned repositories; shared read models are allowed, direct table/internals are not. |
| RULE-010 GitHub projects are replaceable components/references | Agree | Copyleft/license and operational fit prohibit treating external repositories as ContentOS core. |
