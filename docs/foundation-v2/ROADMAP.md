# Roadmap

Initial engineering sequence, not a commitment to redesign or release. At most two development tasks concurrently; Phase0 starts with one writer.

| Phase | Concrete outcome | Dependency / exit |
| --- | --- | --- |
| Phase0 A — this delivery | Seven baseline documents; Foundation PR trigger; six unchanged CI jobs; pushed feature branch and draft PR | Verified V1 baseline; actual check/remote evidence in PROGRESS; API permissions must work for remote acceptance |
| Phase0 B — minimal next task | Table ownership and SQL access map for Job/Video/Intelligence, documenting actual exceptions | Phase0 A review; read-only audit first; no invariant changes without ADR/review |
| Phase0 C — focused hardening | One reproducible recovery/compatibility gap chosen from Phase0 B evidence, with acceptance test | No speculative refactor; preserve contracts/migration history; all six CI gates |
| Later foundation work | Prioritize runtime lifecycle and evidence/check coverage based on measured defects | Reviewed scope and acceptance criteria required before implementation |

First follow-up should audit Job/Video/Intelligence SQL boundaries and identify one testable risk; avoid broad generic workflow or utility abstractions. Refresh stale module READMEs within that scoped inventory task if useful. A full UI/product rewrite, migration reset, real account publishing and paid infrastructure are outside this roadmap's authorization.
