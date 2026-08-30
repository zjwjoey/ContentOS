import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Standalone Quick Edit UI exposes upload, planner, manifest and exact render flow', async () => {
  const page = await readFile('apps/web/app/video/quick-edit/page.tsx', 'utf8');
  for (const text of ['/api/v1/video/quick-edits', '上传视频 / 配音', '主配音', 'Generate Plan', 'Manifest', 'manifests/${manifest.id}/render', '/api/v1/jobs/${renderJob.id}', '素材库', '时间线', '镜头 Inspector', 'Render 成品', 'outputAssetId']) assert.match(page, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const inspector = await readFile('apps/web/components/video/clip-inspector.tsx', 'utf8');
  for (const text of ['REROLL', 'REPLACE', 'TRIM', 'REMOVE', 'REORDER']) assert.match(inspector, new RegExp(text));
  assert.doesNotMatch(page, /projects\/\$\{projectId\}/);
  assert.doesNotMatch(page, /READY 视频 Asset ID（逗号或换行分隔/);
});

test('Standalone historical Manifest revisions are read-only while the current revision remains editable', async () => {
  const page = await readFile('apps/web/app/video/quick-edit/page.tsx', 'utf8');
  const inspector = await readFile('apps/web/components/video/clip-inspector.tsx', 'utf8');
  const picker = await readFile('apps/web/components/video/manifest-revision-picker.tsx', 'utf8');
  assert.match(page, /isCurrentManifest/);
  assert.match(page, /历史版本仅供查看/);
  assert.match(page, /refreshSession/);
  assert.match(inspector, /editable/);
  assert.match(inspector, /disabled=\{!editable(?: \|\| busy)?\}/);
  assert.match(picker, /isCurrentManifest\(item\.id, currentId\)/);
  assert.match(picker, /selectedId/);
  assert.match(picker, /value=\{selectedId \|\| ''\}/);
  assert.match(page, /selectedId=\{manifest\?\.id\}/);
  assert.match(page, /currentId=\{session\.currentManifestId \|\| undefined\}/);
});

test('Standalone planner uses optional voice-driven duration and locks settings after planning', async () => {
  const page = await readFile('apps/web/app/video/quick-edit/page.tsx', 'utf8');
  assert.match(page, /durationMode/);
  assert.match(page, /AUTO/);
  assert.match(page, /targetDurationMs: targetDurationSeconds \* 1000/);
  assert.match(page, /maxClipDurationSeconds.*5/);
  assert.match(page, /plannerLocked/);
  assert.match(page, /需要选择主配音/);
});
