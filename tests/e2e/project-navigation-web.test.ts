import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('project product model freezes the five-stage browser vocabulary and Approval Gate copy', async () => {
  const model = await readFile(new URL('../../apps/web/app/projects/[id]/product-model.ts', import.meta.url), 'utf8');
  for (const stage of ['ASSETS', 'DIRECTOR', 'VIDEO', 'APPROVALS', 'PUBLISHER']) assert.match(model, new RegExp(stage));
  assert.match(model, /Approval Gate/);
  assert.doesNotMatch(model, /Review/);
});

test('Director page exposes Assets and conditional Video handoff routes', async () => {
  const page = await readFile(new URL('../../apps/web/app/projects/[id]/director/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /projects\/\$\{projectId\}\/assets/);
  assert.match(page, /projects\/\$\{projectId\}\/video/);
});
