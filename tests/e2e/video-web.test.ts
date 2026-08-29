import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Video workspace is browser-operated and binds Approval to the exact Render output', async () => {
  const page = await readFile('apps/web/app/projects/[id]/video/page.tsx', 'utf8');
  assert.match(page, /video\/jobs/);
  assert.match(page, /video\/jobs\/\$\{snapshot\.job\.id\}\/cancel/);
  assert.match(page, /videoAssetIds/);
  assert.match(page, /voiceAssetId/);
  assert.match(page, /subtitleText/);
  assert.match(page, /targetDurationMs/);
  assert.match(page, /setInterval/);
  assert.match(page, /送往 Approval Gate/);
  assert.match(page, /targetId: target\.renderId/);
  assert.match(page, /targetRevisionId: target\.outputAssetId/);
  assert.match(page, /assets\/\$\{snapshot\.currentRender\.outputAssetId\}\/content/);
  assert.doesNotMatch(page, /ffmpeg|ffprobe|chromium|playwright|storageKey|sourcePath/i);
});
