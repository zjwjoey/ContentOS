import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Publisher Operator is project scoped and exposes the Fake publish lifecycle', async () => {
  const page = await readFile('apps/web/app/projects/[id]/publisher/page.tsx', 'utf8');
  assert.match(page, /projects\/\$\{projectId\}\/publisher\/accounts/);
  assert.match(page, /projects\/\$\{projectId\}\/publisher\/requests/);
  assert.match(page, /approvals`/);
  assert.match(page, /publisher\/requests\/\$\{requestId\}\/queue/);
  assert.match(page, /projects\/\$\{projectId\}\/publisher\/assets/);
  assert.match(page, /Approval Gate/);
  assert.match(page, /NEEDS_HUMAN_ACTION/);
  assert.match(page, /Fake Platform/);
  assert.match(page, /发布请求/);
  assert.match(page, /PUBLISHED/);
  assert.match(page, /PublishAttempt/);
  assert.match(page, /ExternalPost/);
  assert.match(page, /targetRevisionId/);
  assert.match(page, /fake-outcome/);
  assert.match(page, /开发模拟结果/);
  assert.doesNotMatch(page, /批准并入队/);
  assert.doesNotMatch(page, /人工审核/);
  assert.doesNotMatch(page, /credential|cookie|accessToken|refreshToken|authorization|browserProfile/i);
});

test('Director and Publisher pages provide project-local navigation', async () => {
  const director = await readFile('apps/web/app/projects/[id]/director/page.tsx', 'utf8');
  const publisher = await readFile('apps/web/app/projects/[id]/publisher/page.tsx', 'utf8');
  assert.match(director, /href=\{`\/projects\/\$\{projectId\}\/publisher`\}/);
  assert.match(publisher, /href=\{`\/projects\/\$\{projectId\}\/director`\}/);
});

test('Publisher development composition is not mistaken for the fail-closed main entrypoint', async () => {
  const main = await readFile('workers/publisher-worker/src/main.ts', 'utf8');
  assert.match(main, /basename\(process\.argv\[1\] \?\? ''\) === 'main\.ts'/);
});
