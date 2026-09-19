import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dedupeExternalQueries, FakeExternalVideoProvider, planVisuals, PexelsVideoProvider, rankLocalCandidates, pickPexelsFile, classifyVisualEntities } from '../../packages/modules/video/src/index.js';

test('VisualPlan protects named entities and deduplicates external queries', () => {
  const plan = planVisuals('MIZAN 在科技工厂升级产品。今天展示科技产品。');
  assert.equal(plan.segments[0]?.requiresAuthenticEntityVisual, true);
  assert.ok(plan.segments[0]?.entities.includes('MIZAN'));
  assert.deepEqual(dedupeExternalQueries(plan), [...new Set(dedupeExternalQueries(plan))]);
});

test('local ranking prefers entity and penalizes recent usage', () => {
  const plan = planVisuals('MIZAN 门店展示');
  const ranked = rankLocalCandidates(plan.segments[0]!, [
    { id: 'generic', storageKey: 'a', sourcePath: 'generic.mp4', durationMs: 5000, tags: ['门店'], recentUsageCount: 0 },
    { id: 'entity', storageKey: 'b', sourcePath: 'MIZAN-store.mp4', durationMs: 5000, tags: ['MIZAN'], recentUsageCount: 0 },
  ]);
  assert.equal(ranked[0]?.id, 'entity');
});

test('Pexels adapter blocks non-allowlisted downloads', async () => {
  const provider = new PexelsVideoProvider('key', async () => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(() => provider.download({ provider: 'pexels', assetId: '1', width: 100, height: 100, durationMs: 1000, files: [{ id: '1', width: 100, height: 100, durationMs: 1000, url: 'https://evil.example/video.mp4' }] }, 'unused.mp4'), /PEXELS_DOWNLOAD_URL_BLOCKED/);
});

test('Fake provider is deterministic and offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-hybrid-')); const fixture = join(root, 'fixture.mp4'); const output = join(root, 'out.mp4'); await writeFile(fixture, 'video');
  const provider = new FakeExternalVideoProvider(fixture); const first = await provider.search({ query: 'city' }); const second = await provider.search({ query: 'city' }); assert.equal(first.results[0]?.assetId, second.results[0]?.assetId); await provider.download(first.results[0]!, output); assert.equal(await readFile(output, 'utf8'), 'video');
});

test('concepts are not treated as authentic entities', () => {
  const details = classifyVisualEntities('商业合作需要市场磨合，观点不同但可以选择。');
  assert.deepEqual(details, []);
  assert.equal(planVisuals('商业合作需要市场磨合').segments[0]?.requiresAuthenticEntityVisual, false);
});

test('Pexels file ranking prefers portrait and nearest 9:16', () => {
  const file = pickPexelsFile({ provider: 'pexels', assetId: '1', width: 1080, height: 1920, durationMs: 1000, files: [
    { id: 'landscape', width: 1920, height: 1080, durationMs: 1000, url: 'https://videos.pexels.com/landscape.mp4' },
    { id: 'portrait', width: 1080, height: 1920, durationMs: 1000, url: 'https://videos.pexels.com/portrait.mp4' },
  ] });
  assert.equal(file.id, 'portrait');
});
