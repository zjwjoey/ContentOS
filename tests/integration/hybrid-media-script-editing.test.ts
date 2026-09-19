import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { AssetService } from '../../packages/modules/asset/src/index.js';
import { FakeExternalVideoProvider, HybridMediaService, buildScriptMontageManifest, planVisuals, type ExternalVideoProvider } from '../../packages/modules/video/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';

test('hybrid resolver produces a resolved assignment without real provider calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-hybrid-integration-')); const fixture = join(root, 'fixture.mp4'); await writeFile(fixture, 'video');
  const storage = new LocalStorageProvider(root); const provider = new FakeExternalVideoProvider(fixture);
  const assetService = { importFile: async () => ({ id: 'asset-external-1', projectId: '', checksum: 'sha256:test', storageKey: 'objects/test.mp4', byteSize: 5, status: 'READY' as const }) };
  const service = new HybridMediaService(assetService as never, storage, provider as ExternalVideoProvider);
  const result = await service.resolve({ workspaceId: 'workspace-test', script: 'MIZAN 在华沙开设门店。商业合作正在推进。', localAssets: [], usePexels: true });
  assert.equal(result.resolvedPlan.segments.length, planVisuals('MIZAN 在华沙开设门店。商业合作正在推进。').segments.length);
  assert.equal(result.resolvedAssignments[0]?.selectedSource, 'FAKE_PEXELS');
  assert.ok(provider.searchCount >= 1);
  assert.equal(result.diagnostics.sourceStats.pexels, 2);
});

test('resolved assignment order is preserved in the final manifest', () => {
  const assets = ['asset-A', 'asset-B', 'asset-C'].map((id) => ({ id, storageKey: id, sourcePath: `${id}.mp4`, durationMs: 8_000, tags: ['unrelated'] }));
  const result = buildScriptMontageManifest({ workspaceId: 'workspace-test', script: '第一句话。第二句话。第三句话。', sentences: [{ index: 0, text: '第一句话。', normalizedText: '第一句话' }, { index: 1, text: '第二句话。', normalizedText: '第二句话' }, { index: 2, text: '第三句话。', normalizedText: '第三句话' }], assets, seed: 1, minClipDurationMs: 2_000, maxClipDurationMs: 2_000, resolvedAssignments: assets.map((asset, segmentIndex) => ({ segmentIndex, selectedAssetId: asset.id, selectedSource: 'LOCAL' as const, selectedRole: 'GENERIC_BROLL' as const, entityFallback: false, matchScore: 100, reason: 'fixed resolver decision', visualIntent: `intent-${segmentIndex}`, matchedKeywords: [] })) });
  assert.deepEqual(result.manifest.timeline.map((clip) => clip.assetId), ['asset-A', 'asset-B', 'asset-C']);
  assert.equal(result.manifest.timeline[1]?.matching?.visualIntent, 'intent-1');
});

test('persistent search and provider-identity download caches survive a second resolve', { skip: !process.env.DATABASE_URL }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-hybrid-cache-')); const fixture = join(root, 'fixture.mp4'); await writeFile(fixture, 'video');
  const db = await createDatabase(process.env.DATABASE_URL!); await migrateUp(db); const workspaceId = `hybrid-cache-${randomUUID()}`; await db.query("insert into video_workspaces (id,type,project_id) values ($1,'STANDALONE',null)", [workspaceId]);
  const storage = new LocalStorageProvider(join(root, 'storage')); const provider = new FakeExternalVideoProvider(fixture); const assets = new AssetService(db, storage); const service = new HybridMediaService(assets, storage, provider, db);
  try {
    await service.resolve({ workspaceId, script: '商业合作正在推进。市场观点正在形成。', localAssets: [], usePexels: true });
    const firstSearches = provider.searchCount; const firstDownloads = provider.downloadCount; assert.ok(firstSearches > 0); assert.ok(firstDownloads > 0);
    await service.resolve({ workspaceId, script: '商业合作正在推进。市场观点正在形成。', localAssets: [], usePexels: true });
    assert.equal(provider.searchCount, firstSearches); assert.equal(provider.downloadCount, firstDownloads);
    const provenance = await db.query<{ provider: string; provider_asset_id: string; provider_file_id: string }>('select provider,provider_asset_id,provider_file_id from external_media_assets where asset_id in (select asset_id from video_workspace_assets where workspace_id=$1)', [workspaceId]);
    assert.ok(provenance.rows.length > 0); assert.equal(provenance.rows[0]?.provider, 'fake-pexels');
  } finally { await db.query('delete from video_workspaces where id=$1', [workspaceId]); await db.end(); await rm(root, { recursive: true, force: true }); }
});
