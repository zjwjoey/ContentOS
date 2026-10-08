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

| FV2-007 | Post-build runtime suite fails process-tree termination (22/23); cloud PID1 retains zombie Node processes, isProcessAlive uses kill(pid,0) | P1 / reproduced local failure; root cause unconfirmed | Reproduce unchanged baseline in a reaping Linux runner and distinguish terminated zombie from running child before proposing any runtime change |

Priorities express delivery order, not measured incident severity. Worker failure injection, actual vendor integrations and embedded PostgreSQL upgrade behavior require separate evidence before adding defects.
