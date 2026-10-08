# Acceptance Matrix

Statuses must be supported by source, an executed command, or an exact-SHA remote result. Historical evidence is never substituted for current-run evidence.

| Criterion | Verification | Initial status / evidence location |
| --- | --- | --- |
| Correct base and branch isolation | git ls-remote; ahead/behind; feature and integration branch SHA | PASS at creation: both 27d43854f0571d127bb1ed4ac01334ff294409b2; main unchanged |
| Seven initial documents, honest audit scope | Review this directory and explicit inspected/pending entries | Authored; scoped source inspection only |
| Foundation PR event and codex/integration pushes | Target trigger inspection and baseline workflow comparison | Exact Foundation target added; existing push patterns retained |
| Six original gates and dependency edges | Compare entire jobs section to baseline; resolve every needs target | PASS: entire jobs section matches baseline; all needs targets exist |
| Frozen toolchain/install | Node24; pnpm10.32.1 install --frozen-lockfile | PASS with pinned 10.32.1; default global pnpm differs |
| Static checks/build | pnpm format, lint, typecheck, build and apps/web build | PASS; detailed actual execution in PROGRESS |
| Reset guard and runtime regression | Existing test-database-safety and runtime unit tests | Reset guard PASS 4/4; post-build runtime FAIL 22/23; see PROGRESS |
| Real DB / migration / workers | PG16 isolated contentos_test; existing migration matrix/full DB suite | Not yet executed locally; no production database/reset allowed |
| Browser/render | Existing browser-and-render job on this head | Requires actual remote evidence; historical run is separate |
| Windows runtime/package/install | Existing two Windows jobs on this head | Linux cloud cannot supply local Windows evidence |
| Remote feature delivery | Commit, push, ls-remote final SHA | Final verification in PROGRESS/report |
| Draft PR target | integration/contentos-foundation-v2; draft true | API operation must be verified; never target main |
| Exact-head remote CI | Run URL, head SHA, event, six job conclusions | Pending metadata access, never infer from push |

Historical run supplied by handoff: https://github.com/zjwjoey/ContentOS/actions/runs/37558204860 at baseline 27d43854f0571d127bb1ed4ac01334ff294409b2, reportedly six jobs passed. This session's gh API re-read returned Forbidden, so that result remains handoff evidence rather than independently revalidated execution.
