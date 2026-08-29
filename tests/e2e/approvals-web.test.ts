import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Approval Gate page only acts on exact target revisions and requires rejection reasons', async () => {
  const page = await readFile('apps/web/app/projects/[id]/approvals/page.tsx', 'utf8');
  assert.match(page, /projects\/\$\{projectId\}\/approvals/);
  assert.match(page, /targetRevisionId/);
  assert.match(page, /驳回必须填写理由/);
  assert.match(page, /成片 Approval Gate/);
  assert.match(page, /发布 Revision Approval Gate/);
  assert.doesNotMatch(page, /Review/);
});
