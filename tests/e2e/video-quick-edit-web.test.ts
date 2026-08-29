import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Video Quick Edit UI exposes version history, trim/remove/reorder and exact render controls', async () => {
  const page = await readFile('apps/web/app/projects/[id]/video/page.tsx', 'utf8');
  for (const text of ['video/manifests', 'video/quick-edits', '生成 Quick Edit 版本', '创建精确渲染 Job', 'TRIM', 'REMOVE', 'REORDER', 'Manifest v']) assert.match(page, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(page, /ffmpeg|ffprobe|storageKey|sourcePath/i);
});
