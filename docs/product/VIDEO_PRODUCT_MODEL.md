# ContentOS Video Product Model V1

ContentOS Video has two distinct product entries that share one execution core:

```text
Video
├── Project Video
│   ├── Planner
│   ├── Manifest
│   └── Video Adjustment
└── Standalone Quick Edit
    ├── Asset Input
    ├── Voice Input
    ├── Random Montage Planner
    ├── Manifest Preview
    ├── Video Adjustment
    └── Render
```

Project Video is driven by an approved Director pair. Standalone Quick Edit has no Content Project, Director, Script or Storyboard requirement. Both paths use the same immutable `EDIT_MANIFEST_V0` revisions, exact render jobs, Video Worker and FFmpeg renderer.

`Video Adjustment` is the shared manifest-editing capability. It applies TRIM, REMOVE, REORDER, REPLACE and REROLL to a selected parent revision and never mutates the parent.

