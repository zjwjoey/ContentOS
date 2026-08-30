import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Project Center uses the approved navigation and safe fields', async () => {
  const page = await readFile('apps/web/app/projects/[id]/page.tsx', 'utf8');
  assert.match(page, /api\/v1\/projects\/.*center/);
  assert.match(page, /DIRECTOR/);
  assert.match(page, /PUBLISHER/);
  assert.match(page, /health|健康度/);
  assert.match(page, /actions|待处理/);
  assert.match(page, /recentJobs/);
  assert.match(page, /data-status/);
  assert.match(page, /current-stage-summary/);
  assert.match(page, /message && snapshot/);
  assert.doesNotMatch(page, /credentialRef|profileKey|accessToken|refreshToken|authorization|diagnostics/i);
});

test('Project list enters Project Center', async () => {
  const home = await readFile('apps/web/app/page.tsx', 'utf8');
  assert.match(home, /projects\/\$\{project\.id\}/);
  assert.doesNotMatch(home, /projects\/\$\{project\.id\}\/director/);
});

test('Project Center uses the shared five-stage navigation shell', async () => {
  const page = await readFile('apps/web/app/projects/[id]/page.tsx', 'utf8');
  const nav = await readFile('apps/web/app/projects/[id]/product-model.ts', 'utf8');
  assert.match(page, /ProjectNav/);
  for (const stage of ['ASSETS', 'DIRECTOR', 'VIDEO', 'APPROVALS', 'PUBLISHER']) assert.match(nav, new RegExp(stage));
});
