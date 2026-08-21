# Remotion: V1 Fit and License Analysis

## B1 — does it simplify the V1 pipeline?

For V1 random material selection, trimming, concatenation, basic transitions and SRT subtitles, **it increases complexity**. Remotion requires a Node/React composition bundle and Chromium-based frame rendering around a job that FFmpeg can execute directly. `packages/renderer/package.json` exposes the Node renderer; `packages/player/package.json` exposes an embedded React preview. Both add a JavaScript rendering subsystem even if ContentOS’s planner already knows exact clip times.

## B2 — highest-value boundary

| Scope | Remotion value |
|---|---|
| V1 required | None for the core renderer; use FFmpeg directly. |
| V2 possible | Preview/approval of a persisted manifest; advanced caption styles or a small set of branded templates. |
| Not required now | Studio/editor, arbitrary timeline editing, cloud rendering and a general template marketplace. |

`packages/captions/src/{parse-srt,create-tiktok-style-captions}.ts` demonstrates a useful standalone caption utility seam. `packages/core/src/{Composition,Sequence,TimelineContext}.tsx` shows that the composition/timeline is React runtime state, not a neutral edit-plan format.

## B3 — future value

Its value rises materially for animated caption words, data cards, logo motion, dynamic layouts and AI-authored visual templates. Those are composition/template problems. Preserve the option by making `EDIT_MANIFEST_V0` renderer-neutral; do not route V1 renders through Remotion.

## B4 — license

The pinned root `LICENSE.md` is the **Remotion License**, not MIT. Research/evaluation is permitted. Commercial/internal use is free only for an individual, non-profit, or for-profit organization with up to three employees; larger for-profit organizations require a Company License. `@remotion/renderer` and `@remotion/player` declare `SEE LICENSE IN LICENSE.md`. `@remotion/captions` declares MIT, but validate the installed package/version before isolated use. Never assume the repository is uniformly MIT, and recheck terms before adoption.

## Verdict

Reject Remotion as a V1 render dependency; retain it as an optional V2 Template/Preview Renderer behind the Edit Manifest contract.
