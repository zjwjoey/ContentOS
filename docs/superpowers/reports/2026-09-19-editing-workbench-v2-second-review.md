# Editing Workbench V2 — Second Review

Date: 2026-09-19  
Branch: `codex/editing-workbench-v2`  
Baseline: `ace263275dc14b660807d5fb910816a69df5f220e`

## Review status

| Area | Status | Evidence / remaining work |
| --- | --- | --- |
| Basename pairing | OPEN | Pairing currently keys the complete path, strips extensions with a regex, and silently overwrites duplicate keys. It does not apply basename-only, NFKC, trim, and case-insensitive normalization. |
| Cross-volume audio upload | OPEN | Upload promotion renames the staging file directly into the configured media root. A cross-volume rename can fail. |
| Durable batch/item facts | OPEN | The HTTP request scans, prepares, and renders synchronously. Item rows are created after preparation, so a crash can leave `total_count` inconsistent with item rows. |
| Prepare/render retry | OPEN | Retry only covers items with an existing manifest and has no compare-and-set/idempotency guard for concurrent retry requests. |
| Source/voice path authorization | PARTIALLY FIXED | Output roots use realpath containment. Source roots and voice files still need strict existing-path, type, and symlink/junction containment checks. |
| Worker path defense | OPEN | The worker boundary needs an immutable-manifest path authorization check before file access. |
| Export durability and race safety | OPEN | Export is synchronous, uses a TOCTOU existence check, and does not persist a durable export job before copying. Cleanup on all failure paths is incomplete. |
| Pairing UI | OPEN | The API does not expose duplicate pairing statuses; the UI therefore cannot render explicit duplicate/missing rows without filtering. |
| Advanced settings / permissions | OPEN | Seed and environment-oriented settings remain visible; source/output permission details are not presented as read-only status. |
| Scan reuse / jobization | OPEN | Root scans run inline and do not reuse a persisted completed scan before rescanning. |
| Batch status API | OPEN | Batch detail performs per-item job lookups (N+1) and has no pagination. It derives total count from returned rows instead of the persisted batch total. |
| Browser and regression coverage | PARTIALLY FIXED | A browser suite exists, but the new basename, cross-volume, crash/restart, retry, and export race cases are not covered. |
| Migration / release gates | OPEN | A new forward migration, full test evidence, and a hardening report are still required. |

## Priority

P0: basename pairing, cross-volume upload, durable batch facts, retry idempotency, and path authorization.  
P1: worker defense, export durability, UI pairing/settings, batch pagination/N+1, and scan reuse.  
P2: browser additions, documentation, and final release evidence.

This report is intentionally written before implementation so every finding has an explicit disposition in the final hardening report.
