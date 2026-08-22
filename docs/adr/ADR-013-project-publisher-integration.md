# ADR-013: Project-Owned Publisher Integration Through Public Contracts

## Status

Accepted.

## Decision

Content Project remains the owner of project lifecycle state. Publisher remains the owner of accounts, publish requests, attempts and confirmed external posts. The integration uses public application contracts:

- Publisher exposes a project-scoped `PublisherProjectSummary` with request status counts, account count, confirmed external-post count and human-action count.
- Project accepts explicit `ProjectPublishingFacts` and derives `READY_TO_PUBLISH` or `PUBLISHED` without reading Publisher tables.
- API and Worker composition roots coordinate Publisher summaries with the public Asset Catalog contract.
- A project-level handoff creates one immutable Publish Revision per selected account. Each account has an independent Approval Gate, Job, Attempt and external outcome.

Only a confirmed external post can move a project to `PUBLISHED`. An uncertain publish remains `READY_TO_PUBLISH` until reconciliation confirms the external post.

## Boundary rules

Project code never queries `publisher_accounts`, `publisher_requests`, `publisher_attempts` or `publisher_external_posts`. Publisher code never updates `content_projects` directly. Cross-module state changes travel through the public service contracts at the API or Worker composition boundary.

## Consequences

- Project Center can later consume one stable project summary instead of private Publisher tables.
- Multi-account publishing supports partial success and account-specific human action.
- Project status is eventually synchronized after API/Worker outcomes; it is never inferred from queue delivery state alone.
- A future Review/Metric Snapshot module can attach to confirmed external posts without changing the Publisher request contract.
