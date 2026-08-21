# Director Module V0

## Boundary

Director owns creative planning: briefs, topics, script revisions, hooks, titles, storyboard revisions and explicit creative approvals. It can request AI-assisted generation through the AI module, but remains the source of truth for accepted creative output.

## Revision model

Each generated or manually edited artifact is a revision with author, prompt/version provenance where applicable, input references, creation time and approval state. A user may approve one script/storyboard revision for downstream video planning; changing it creates a new revision and never rewrites a manifest already rendered.

## Commands

| Command | Result |
|---|---|
| `CreateBrief` / `ReviseBrief` | project-linked planning context |
| `GenerateCreativeDraft` | AI run request with schema/prompt version |
| `AcceptCreativeDraft` | durable script/hook/title/storyboard revision |
| `ApproveStoryboard` | permits Video manifest planning |
| `RequestCreativeRevision` | explicitly invalidates downstream readiness without deleting history |

AI output is untrusted input until schema validation, policy validation and human/automation acceptance are complete. Director records the model/provider/prompt metadata needed for reproducibility; it never persists secrets or model chain-of-thought.

## Dependencies

Director depends on Project context, AI application ports and Asset query references for storyboard source choices. It must not create FFmpeg commands, publish directly, own platform accounts or bypass Review policy.
