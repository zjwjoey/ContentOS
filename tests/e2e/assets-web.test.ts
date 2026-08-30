import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Assets workspace is API-backed and exposes upload, progress, preview and Director handoff', async () => {
  const page = await readFile(new URL('../../apps/web/app/projects/[id]/assets/page.tsx', import.meta.url), 'utf8');
  for (const value of ['/asset-imports', '/assets', '/content', '上传中', '排队中', '处理中', '可用', '已去重', '进入 Director']) assert.match(page, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(page, /storageKey|sourcePath|ffmpeg|playwright/i);
});
