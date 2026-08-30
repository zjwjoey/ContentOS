import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Operator UI V1 exposes global shell and approved project-scoped navigation', async () => {
  const layout = await readFile('apps/web/app/layout.tsx', 'utf8');
  const home = await readFile('apps/web/app/page.tsx', 'utf8');
  const nav = await readFile('apps/web/app/projects/[id]/project-nav.tsx', 'utf8');
  const model = await readFile('apps/web/app/projects/[id]/product-model.ts', 'utf8');
  assert.match(layout, /OperatorShell/);
  assert.match(home, /快速剪辑|Quick Edit/);
  for (const stage of ['Overview', 'Assets', 'Director', 'Video', 'Approval', 'Publisher']) assert.match(`${nav}\n${model}`, new RegExp(stage));
  assert.doesNotMatch(home, /Review Analytics/);
});

test('Operator UI V1 project pages expose visual workflow primitives', async () => {
  const director = await readFile('apps/web/app/projects/[id]/director/page.tsx', 'utf8');
  const video = await readFile('apps/web/app/projects/[id]/video/page.tsx', 'utf8');
  const approvals = await readFile('apps/web/app/projects/[id]/approvals/page.tsx', 'utf8');
  const publisher = await readFile('apps/web/app/projects/[id]/publisher/page.tsx', 'utf8');
  assert.match(director, /Storyboard|Visual Instruction|素材关键词/);
  const inspector = await readFile('apps/web/components/video/clip-inspector.tsx', 'utf8');
  for (const text of ['时间线', 'TRIM', 'REMOVE', 'REORDER', 'REPLACE', 'REROLL']) assert.match(`${video}\n${inspector}`, new RegExp(text));
  assert.match(approvals, /Approval Queue|拒绝原因/);
  assert.match(publisher, /下一步|Fake Platform/);
});
