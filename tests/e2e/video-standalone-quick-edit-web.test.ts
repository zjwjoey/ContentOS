import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Standalone Quick Edit UI exposes upload, planner, manifest and exact render flow', async () => {
  const page = await readFile('apps/web/app/video/quick-edit/page.tsx', 'utf8');
  for (const text of ['/api/v1/video/quick-edits', '批量上传 Video / Voice', 'Asset Worker', 'Generate Plan', 'Manifest 预览', 'manifests/${manifest.id}/render']) assert.match(page, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(page, /projects\/\$\{projectId\}/);
});
