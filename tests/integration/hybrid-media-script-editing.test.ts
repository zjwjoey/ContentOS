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

test('closure resolver keeps authentic entities reusable, prefers relevant external b-roll and preserves final manifest assignments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-hybrid-closure-')); const fixture = join(root, 'fixture.mp4'); await writeFile(fixture, 'video');
  const storage = new LocalStorageProvider(join(root, 'storage')); const provider = new FakeExternalVideoProvider(fixture); let importCount = 0;
  const assetService = { importFile: async (input: { metadata?: Record<string, unknown> }) => ({ id: `external-${++importCount}`, projectId: '', checksum: `sha256:${importCount}`, storageKey: `objects/external-${importCount}.mp4`, byteSize: 5, status: 'READY' as const, metadata: input.metadata || {} }) };
  const service = new HybridMediaService(assetService as never, storage, provider);
  const script = 'MIZAN正在波兰拓展业务。商业合作本来就会有不同观点。我会继续在MIZAN招商部工作。欢迎大家以后继续交流合作。';
  const local = [
    { id: 'mizan-real', storageKey: 'mizan', sourcePath: 'MIZAN-store.mp4', durationMs: 12_000, tags: ['MIZAN', '门店'] },
    { id: 'product', storageKey: 'product', sourcePath: 'product.mp4', durationMs: 12_000, tags: ['商品'] },
    { id: 'unrelated', storageKey: 'unrelated', sourcePath: 'plastic-basin.mp4', durationMs: 12_000, tags: ['塑料盆'] },
  ];
  try {
    const resolved = await service.resolve({ workspaceId: 'closure-workspace', script, localAssets: local, usePexels: true, minClipDurationMs: 2_000, maxClipDurationMs: 5_000 });
    assert.equal(resolved.resolvedAssignments[0]?.selectedSource, 'LOCAL'); assert.equal(resolved.resolvedAssignments[0]?.selectedRole, 'AUTHENTIC_ENTITY');
    assert.equal(resolved.resolvedAssignments[1]?.selectedSource, 'FAKE_PEXELS');
    assert.equal(resolved.resolvedAssignments[2]?.selectedAssetId, 'mizan-real'); assert.equal(resolved.resolvedAssignments[2]?.selectedRole, 'AUTHENTIC_ENTITY'); assert.equal(resolved.resolvedAssignments[2]?.allowAssetReuse, true);
    const planned = buildScriptMontageManifest({ workspaceId: 'closure-workspace', script, sentences: [], assets: [...local, ...resolved.assets.filter((asset) => !local.some((candidate) => candidate.id === asset.id))], resolvedAssignments: resolved.resolvedAssignments, seed: 1, minClipDurationMs: 2_000, maxClipDurationMs: 5_000 });
    assert.equal(planned.manifest.timeline[0]?.matching?.selectedRole, 'AUTHENTIC_ENTITY'); assert.equal(planned.manifest.timeline[0]?.matching?.selectedSource, 'LOCAL'); assert.equal(planned.manifest.timeline[2]?.assetId, 'mizan-real');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closure external candidate pool avoids duplicate provider identities when candidates are available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-hybrid-duplicates-')); const fixture = join(root, 'fixture.mp4'); await writeFile(fixture, 'video');
  const provider = new FakeExternalVideoProvider(fixture); const storage = new LocalStorageProvider(join(root, 'storage')); let index = 0; const service = new HybridMediaService({ importFile: async () => ({ id: `external-${++index}`, projectId: '', checksum: `sha256:${index}`, storageKey: `objects/${index}.mp4`, byteSize: 5, status: 'READY' as const }) } as never, storage, provider);
  try { const result = await service.resolve({ workspaceId: 'duplicate-workspace', script: '商业合作需要不同观点。商业合作需要不同选择。', localAssets: [], usePexels: true, minClipDurationMs: 2_000, maxClipDurationMs: 5_000 }); const identities = result.resolvedAssignments.map((assignment) => assignment.selectedAssetId); assert.equal(new Set(identities).size, identities.length); } finally { await rm(root, { recursive: true, force: true }); }
});

test('entity integrity keeps place-only local material as a marked fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-hybrid-entity-fallback-')); const fixture = join(root, 'fixture.mp4'); await writeFile(fixture, 'video');
  const storage = new LocalStorageProvider(join(root, 'storage')); const provider = new FakeExternalVideoProvider(fixture); const service = new HybridMediaService({ importFile: async () => ({ id: 'external', projectId: '', checksum: 'sha256:external', storageKey: 'objects/external.mp4', byteSize: 5, status: 'READY' as const }) } as never, storage, provider);
  try {
    const result = await service.resolve({ workspaceId: 'entity-fallback-workspace', script: 'MIZAN正在波兰发展。', localAssets: [{ id: 'poland-street', storageKey: 'poland', sourcePath: 'Poland-Warsaw-street.mp4', durationMs: 8_000, tags: ['波兰', '华沙'] }], usePexels: false });
    assert.equal(result.resolvedAssignments[0]?.selectedAssetId, 'poland-street'); assert.notEqual(result.resolvedAssignments[0]?.selectedRole, 'AUTHENTIC_ENTITY'); assert.equal(result.resolvedAssignments[0]?.selectedRole, 'PLACE_CONTEXT'); assert.equal(result.resolvedAssignments[0]?.entityFallback, true);
    const planned = buildScriptMontageManifest({ workspaceId: 'entity-fallback-workspace', script: 'MIZAN正在波兰发展。', sentences: [], assets: [{ id: 'poland-street', storageKey: 'poland', sourcePath: 'Poland-Warsaw-street.mp4', durationMs: 8_000, tags: ['波兰', '华沙'] }], resolvedAssignments: result.resolvedAssignments, seed: 1, minClipDurationMs: 2_000, maxClipDurationMs: 5_000 });
    assert.equal(planned.manifest.timeline[0]?.matching?.selectedRole, 'PLACE_CONTEXT'); assert.equal(planned.manifest.timeline[0]?.matching?.entityFallback, true); assert.notEqual(planned.manifest.timeline[0]?.matching?.selectedRole, 'AUTHENTIC_ENTITY');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('external reuse is explicit after the two-candidate pool is exhausted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-hybrid-external-reuse-')); const fixture = join(root, 'fixture.mp4'); await writeFile(fixture, 'video');
  const storage = new LocalStorageProvider(join(root, 'storage')); const provider = new FakeExternalVideoProvider(fixture); let index = 0; const service = new HybridMediaService({ importFile: async () => ({ id: `external-${++index}`, projectId: '', checksum: `sha256:${index}`, storageKey: `objects/${index}.mp4`, byteSize: 5, status: 'READY' as const }) } as never, storage, provider);
  try {
    const result = await service.resolve({ workspaceId: 'external-reuse-workspace', script: '商业合作正在推进。商业合作正在推进。商业合作正在推进。', localAssets: [], usePexels: true, minClipDurationMs: 2_000, maxClipDurationMs: 5_000 });
    assert.equal(result.resolvedAssignments.length, 3); assert.notEqual(result.resolvedAssignments[0]?.selectedAssetId, result.resolvedAssignments[1]?.selectedAssetId); assert.notEqual(result.resolvedAssignments[0]?.allowAssetReuse, true); assert.notEqual(result.resolvedAssignments[1]?.allowAssetReuse, true); assert.equal(result.resolvedAssignments[2]?.allowAssetReuse, true); assert.match(result.resolvedAssignments[2]?.reason || '', /复用/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closure external failure uses a marked generic/entity fallback and counts it once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-hybrid-fallback-')); const fixture = join(root, 'fixture.mp4'); await writeFile(fixture, 'video'); const previous = process.env.CONTENTOS_FAKE_PEXELS_FAILURE; process.env.CONTENTOS_FAKE_PEXELS_FAILURE = '1';
  const storage = new LocalStorageProvider(join(root, 'storage')); const provider = new FakeExternalVideoProvider(fixture); const service = new HybridMediaService({ importFile: async () => ({ id: 'never', projectId: '', checksum: 'sha256:never', storageKey: 'never', byteSize: 5, status: 'READY' as const }) } as never, storage, provider);
  try { const result = await service.resolve({ workspaceId: 'fallback-workspace', script: 'MIZAN正在波兰拓展业务。', localAssets: [{ id: 'generic', storageKey: 'generic', sourcePath: 'generic.mp4', durationMs: 12_000, tags: ['无关'] }], usePexels: true }); assert.equal(result.resolvedAssignments[0]?.entityFallback, true); assert.equal(result.diagnostics.fallbackCount, 1); assert.ok(result.diagnostics.warnings.length > 0); } finally { if (previous === undefined) delete process.env.CONTENTOS_FAKE_PEXELS_FAILURE; else process.env.CONTENTOS_FAKE_PEXELS_FAILURE = previous; await rm(root, { recursive: true, force: true }); }
});
