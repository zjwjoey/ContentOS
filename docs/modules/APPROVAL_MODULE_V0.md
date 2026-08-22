# Approval Gate Module V0

Approval owns pre-transition eligibility decisions. It is separate from Review.

An Approval decision always binds:

- `project_id`
- `target_type`
- `target_id`
- `target_revision_id`
- approver, status, evidence and timestamp

Publisher may create a `PUBLISH` Job only when the current `PublishRevision` has an `APPROVED` Approval decision. A request-level or historical approval does not satisfy the gate.

Approval decisions are append-only. A rejection requires a reason; a later approval is a new decision revision. Approval never renders, publishes, collects metrics or calls an AI provider.

Review is reserved for post-publish `MetricSnapshot`, observations, AI performance analysis and recommendations.

