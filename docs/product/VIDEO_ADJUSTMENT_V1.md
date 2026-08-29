# Video Adjustment V1

Video Adjustment means local editing of an existing persisted manifest. It is the formal name for the former project-scoped “Quick Edit” implementation.

Supported immutable operations:

- `TRIM`: change source window and duration for one clip.
- `REMOVE`: remove one clip while preserving the parent revision.
- `REORDER`: apply a complete permutation of clip indexes.
- `REPLACE`: substitute one READY Video Asset while preserving timeline position and duration.
- `REROLL`: deterministically select another READY workspace/project video asset for one clip, avoiding adjacent reuse when possible.

Every successful operation creates a new Manifest Revision with a new digest. Exact Render receives the chosen Manifest ID, revision and digest; the renderer never re-plans or invents creative choices.

Project API: `POST /api/v1/projects/:projectId/video/adjustments`. The old `/video/quick-edits` route remains a deprecated compatibility alias.

