# API Architecture V0

## Shape

The V0 API is a versioned HTTP JSON control-plane API under `/v1`. Controllers are thin adapters: authenticate, validate request shape, invoke one application command/query and map typed outcomes to HTTP. They do not call workers, FFmpeg, Playwright or provider SDKs.

## Command/query patterns

| Pattern | HTTP behavior | Example |
|---|---|---|
| synchronous mutation | `201`/`200` plus revision resource | create project, save brief |
| asynchronous command | `202` plus `jobId`, `resourceId`, status URL | request render, schedule publish |
| query | `200` with stable read model | project detail, render state |
| invalid transition | `409` with machine-readable reason | publish unvalidated render |
| validation | `422` with field errors | malformed Manifest data |

All mutations accept an `Idempotency-Key`; command responses echo the correlation ID. Pagination is cursor-based. Filtering allows only declared fields; never expose internal file paths, credential references, raw worker logs or provider secrets.

## V0 resource surface

| Resource family | Representative routes |
|---|---|
| Projects | `POST /v1/projects`, `GET /v1/projects/{id}` |
| Director | `POST /v1/projects/{id}/briefs`, `/creative-drafts`, `/storyboards/{id}/approve` |
| Assets | `POST /v1/assets/intake`, `GET /v1/assets/{id}`, project links |
| Video | `POST /v1/projects/{id}/manifests`, `POST /v1/renders` |
| Publisher | `POST /v1/publish-requests`, `POST /v1/publish-requests/{id}/schedule` |
| Review | `POST /v1/reviews`, `GET /v1/reviews?subject=` |
| Jobs | `GET /v1/jobs/{id}`, `POST /v1/jobs/{id}/cancel` |

Routes are an interface outline, not a promise to expose every internal command. Formal engineering initialization must produce OpenAPI contracts with schemas, examples, authorization requirements and backward-compatibility tests.

## Error envelope

```json
{
  "error": {"code": "RENDER_NOT_APPROVED", "message": "The selected render is not approved for publishing.", "correlationId": "...", "details": []}
}
```

Stable `code` values are part of the contract. Error messages are safe for users; diagnostic evidence is available only through authorized Job/Review views.
