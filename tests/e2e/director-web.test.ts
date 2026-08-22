import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Director Operator UI is API-backed and keeps credentials out of browser code', async () => {
  const page = await readFile('apps/web/app/projects/[id]/director/page.tsx', 'utf8');
  assert.match(page, /\/director\/brief/);
  assert.match(page, /scripts\/generate/);
  assert.match(page, /storyboards\/generate/);
  assert.match(page, /scripts\/\$\{script\.id\}\/revisions/);
  assert.match(page, /storyboards\/\$\{storyboardId\}\/approve/);
  assert.doesNotMatch(page, /apiKey|accessToken|refreshToken|cookie|authorization/i);
});
