# Video Module V0

## Boundary

Video owns edit planning, immutable edit manifests, render requests, render records and render validation. It is the only module allowed to create `video.render` jobs. It does not execute FFmpeg; the Video Worker does.

## Inputs and outputs

| Command | Preconditions | Result |
|---|---|---|
| `CreateEditManifest` | approved script/storyboard and linked source assets | immutable Manifest revision |
| `RequestRender` | valid Manifest with resolvable assets | Render record + Job |
| `AcceptRenderResult` | active attempt, valid staged output | validated canonical output Asset + Render completion |
| `SupersedeManifest` | a requested creative change | new revision; previous remains auditable |

The render payload contains only `renderId`, `manifestId`, `manifestVersion`, `projectId` and correlation data. The worker fetches the manifest by exact version. It must fail terminally if it cannot resolve required assets, expected checksums or the target profile.

## Render lifecycle

`PLANNED -> QUEUED -> RUNNING -> VALIDATING -> SUCCEEDED | FAILED | CANCELLED` is separate from Project lifecycle. A successful output is immutable and links to a canonical Asset; a replacement is a new Render.

## Rendering policy

V1 uses direct FFmpeg invocations composed by a thin internal command builder. The builder may translate declared manifest operations to a command plan, but no worker may infer creative changes such as reorder, trim, crop, subtitle wording or music selection. Template renderers and Remotion are explicitly deferred to an optional later preview/template boundary.

The Video Worker declares the supported FFmpeg binary, codecs, filters and required font files at startup. Missing capabilities are structured terminal errors; a successful process exit is not sufficient evidence of a valid captioned render.

Validation records duration, dimensions, codec/container, checksum, output size, source manifest version and tool version. A render is publishable only after validation and Review policy allow it.

## Dependencies

Video may read Project revision references and Asset metadata through published query ports. It depends on Job to request execution and Asset to promote results. It must not depend on Publisher, Review implementation, browser adapters or AI providers.
