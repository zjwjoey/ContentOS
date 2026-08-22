import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Publisher Operator is project scoped and exposes the Fake publish lifecycle', async () => {
  const page = await readFile('apps/web/app/projects/[id]/publisher/page.tsx', 'utf8');
  assert.match(page, /projects\/\$\{projectId\}\/publisher\/accounts/);
  assert.match(page, /projects\/\$\{projectId\}\/publisher\/requests/);
  assert.match(page, /approvals\/PUBLISH\/\$\{requestId\}\/\$\{revisionId\}\/approve/);
  assert.match(page, /publisher\/requests\/\$\{requestId\}\/queue/);
  assert.match(page, /projects\/\$\{projectId\}\/publisher\/assets/);
  assert.match(page, /Approval Gate/);
  assert.match(page, /NEEDS_HUMAN_ACTION/);
  assert.match(page, /Fake Platform/);
  assert.match(page, /发布请求/);
  assert.match(page, /PUBLISHED/);
  assert.doesNotMatch(page, /人工审核/);
  assert.doesNotMatch(page, /credential|cookie|accessToken|refreshToken|authorization|browserProfile/i);
});

test('Director and Publisher pages provide project-local navigation', async () => {
  const director = await readFile('apps/web/app/projects/[id]/director/page.tsx', 'utf8');
  const publisher = await readFile('apps/web/app/projects/[id]/publisher/page.tsx', 'utf8');
  assert.match(director, /href=\{`\/projects\/\$\{projectId\}\/publisher`\}/);
  assert.match(publisher, /href=\{`\/projects\/\$\{projectId\}\/director`\}/);
});
