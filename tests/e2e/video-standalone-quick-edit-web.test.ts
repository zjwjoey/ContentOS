import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Standalone Quick Edit UI exposes upload, planner, manifest and exact render flow', async () => {
  const page = await readFile('apps/web/app/video/quick-edit/page.tsx', 'utf8');
  for (const text of ['/api/v1/video/quick-edits', '上传视频 / 配音', 'Generate Plan', 'Manifest', 'manifests/${manifest.id}/render', '素材库', '时间线', '镜头 Inspector', 'Render 成品']) assert.match(page, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const inspector = await readFile('apps/web/components/video/clip-inspector.tsx', 'utf8');
  for (const text of ['REROLL', 'REPLACE', 'TRIM', 'REMOVE', 'REORDER']) assert.match(inspector, new RegExp(text));
  assert.doesNotMatch(page, /projects\/\$\{projectId\}/);
  assert.doesNotMatch(page, /READY 视频 Asset ID（逗号或换行分隔/);
});
