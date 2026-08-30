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

test('Director Operator exposes one-command local startup for API, Web and Worker', async () => {
  const root = await readFile('package.json', 'utf8');
  const web = await readFile('apps/web/package.json', 'utf8');
  const api = await readFile('apps/api/package.json', 'utf8');
  const worker = await readFile('workers/director-worker/package.json', 'utf8');
  const launcher = await readFile('scripts/dev-operator.ts', 'utf8');
  assert.match(root, /dev:operator/);
  assert.match(web, /next dev.*3001/);
  assert.match(api, /"dev"/);
  assert.match(worker, /"dev"/);
  assert.match(launcher, /@contentos\/director-worker/);
  assert.match(launcher, /@contentos\/worker-publisher/);
});

test('Director Operator exposes project creation, complete Brief inputs and Job polling', async () => {
  const home = await readFile('apps/web/app/page.tsx', 'utf8');
  const director = await readFile('apps/web/app/projects/[id]/director/page.tsx', 'utf8');
  assert.match(home, /method: 'POST'/);
  assert.match(home, /创建项目/);
  assert.match(director, /mustInclude/);
  assert.match(director, /mustAvoid/);
  assert.match(director, /\/api\/v1\/jobs\//);
  assert.match(director, /setInterval/);
  assert.match(director, /clearInterval/);
  assert.match(director, /error/);
  assert.match(director, /scripts\/\$\{scriptId\}\/accept.*body: '\{\}'/);
  assert.match(director, /storyboards\/\$\{storyboardId\}\/approve.*body: '\{\}'/);
});

test('Director handoff requires an accepted Script and matching approved Storyboard', async () => {
  const director = await readFile('apps/web/app/projects/[id]/director/page.tsx', 'utf8');
  assert.match(director, /status === 'ACCEPTED'/);
  assert.match(director, /status === 'APPROVED' && storyboard\.scriptRevisionId === acceptedScript\.id/);
  assert.match(director, /返回 Assets/);
  assert.match(director, /进入 Video/);
  assert.match(director, /等待前置条件/);
  assert.match(director, /Video handoff/);
});
