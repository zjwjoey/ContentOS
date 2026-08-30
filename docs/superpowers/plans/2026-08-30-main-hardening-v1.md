# ContentOS Main Hardening V1 Implementation Plan

## Scope

This branch executes the approved P0/P1/P2 hardening prompt from the isolated worktree `codex/main-hardening-v1`. `main` remains unchanged until human review.

## Completed in this pass

- P0: Next.js/React upgrade, production build compatibility, localhost API/Web binding and host configuration.
- P1: formal Approval target boundary (`RENDER`/`PUBLISH`), Director-owned Script/Storyboard gates, and transactional Approval revision locking.
- P2: profile-key and LocalStorage path containment, deterministic planner shuffle, Project Center real stage links.
- Tooling: real ESLint, changed-file Prettier, automatic test discovery/inventory, `security:scan` naming, and GitHub Actions CI.

## Remaining gates

- Run database-backed migration, integration, worker and browser suites against a reachable PostgreSQL test instance.
- Validate CI workflow in GitHub and inspect/enable required branch protections if repository permissions allow.
- Complete any residual P2 Storyboard manual-binding/UI work identified by the source audit.
- Produce final hardening report and PR; stop before merge.
