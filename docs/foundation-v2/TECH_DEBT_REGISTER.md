# Technical Debt Register

Evidence-based initial register. No speculative finding is classified as a confirmed defect.

| ID | Finding and evidence | Priority / status | Smallest next action and acceptance |
| --- | --- | --- | --- |
| FV2-001 | CI pull_request originally targets only main; push already covers codex/** and integration/** | P0 / addressed in this PR | Add exact Foundation target; retain all six job bodies/dependencies; observe actual PR run |
| FV2-002 | Project/Job/Asset/Video/Director READMEs claim reserved implementations while service files exist | P2 / confirmed documentation drift | Refresh module READMEs from source with evidence links; avoid changing runtime behavior |
| FV2-003 | format-check scans apps/workers/packages/scripts/tests but not docs or workflow YAML; only checks terminal space | P2 / confirmed check limitation | Propose scoped documentation/workflow validation; do not claim pnpm format fully validates these new files |
| FV2-004 | Module private-table access has not been audited across all SQL call sites | P1 / investigation, not proven violation | Produce table owner/access map and concrete cross-module exceptions; ADR/review before boundary changes |
| FV2-005 | Historical Desktop 0047 and Intelligence 0047 must coexist by full filename | P1 / protected compatibility obligation | Re-run migration matrix on isolated contentos_test and retain legacy rollback file; do not edit existing migrations |
| FV2-006 | Cloud gh Actions API read returns Forbidden while Git push works | P0 / environment delivery blocker | Restore authorized metadata access; read exact-head CI and create/verify draft PR without credential workarounds |

| FV2-007 | Post-build runtime 22/23; focused baseline/current both fail with killed zombie adopted by PID1 tail; both pass unchanged under external subreaper | P1 / cloud reaping limitation isolated; ordinary runner CI pending | Preserve original assertions/runtime semantics; verify exact-head normal-runner CI; see RUNTIME_PROCESS_TREE_EVIDENCE.md |

Priorities express delivery order, not measured incident severity. Worker failure injection, actual vendor integrations and embedded PostgreSQL upgrade behavior require separate evidence before adding defects.

Bounded source review follow-up: see [five scoped reliability tasks](BOUNDED_RELIABILITY_AUDIT.md). These refine FV2-004 with concrete evidence and add Job/analysis reliability findings without changing runtime. FV2-A01/A02/A03 are source-confirmed gaps requiring DB regression; A04 is a policy decision; A05 is confirmed private-table write debt. None is marked fixed.
