import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { AssetService } from '../../packages/modules/asset/src/index.js';
import { FakeExternalVideoProvider, HybridMediaService, buildRandomSentenceMontageManifest, buildScriptMontageManifest, planVisuals, type ExternalVideoProvider } from '../../packages/modules/video/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { generateFixtureAudio, generateFixtureVideo, probeMedia, renderEditManifest } from '../../packages/infrastructure/ffmpeg/src/index.js';

test('hybrid resolver produces a resolved assignment without real provider calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-hybrid-integration-')); const fixture = join(root, 'fixture.mp4'); await writeFile(fixture, 'video');
  const storage = new LocalStorageProvider(root); const provider = new FakeExternalVideoProvider(fixture);
  let importCount = 0; const assetService = { importFile: async () => ({ id: `asset-external-${++importCount}`, projectId: '', checksum: `sha256:test-${importCount}`, storageKey: `objects/test-${importCount}.mp4`, byteSize: 5, status: 'READY' as const }) };
  const service = new HybridMediaService(assetService as never, storage, provider as ExternalVideoProvider);
  const result = await service.resolve({ workspaceId: 'workspace-test', script: 'MIZAN 在华沙开设门店。商业合作正在推进。', sentences: [{ index: 0, text: 'MIZAN 在华沙开设门店。', normalizedText: 'mizan 在华沙开设门店', durationMs: 3_000 }, { index: 1, text: '商业合作正在推进。', normalizedText: '商业合作正在推进', durationMs: 5_000 }], localAssets: [], usePexels: true });
  assert.equal(result.resolvedPlan.segments.length, planVisuals('MIZAN 在华沙开设门店。商业合作正在推进。').segments.length);
  assert.deepEqual(result.plan.segments.map((segment) => segment.desiredDurationMs), [3_000, 5_000]);
  assert.equal(result.resolvedAssignments[0]?.selectedSource, 'FAKE_PEXELS');
  assert.ok(provider.searchCount >= 1);
  assert.equal(result.diagnostics.sourceStats.pexels, 2);
  const manifest = buildScriptMontageManifest({ workspaceId: 'workspace-test', script: 'MIZAN 在华沙开设门店。商业合作正在推进。', sentences: [{ index: 0, text: 'MIZAN 在华沙开设门店。', normalizedText: 'mizan 在华沙开设门店', durationMs: 3_000 }, { index: 1, text: '商业合作正在推进。', normalizedText: '商业合作正在推进', durationMs: 5_000 }], assets: result.assets, resolvedAssignments: result.resolvedAssignments, seed: 1, minClipDurationMs: 2_000, maxClipDurationMs: 10_000 });
  assert.deepEqual(manifest.manifest.timeline.map((clip) => clip.durationMs), [3_000, 5_000]);
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
    const cacheScript = `商业合作正在推进。${randomUUID()}`;
    await service.resolve({ workspaceId, script: cacheScript, localAssets: [], usePexels: true });
    const firstSearches = provider.searchCount; const firstDownloads = provider.downloadCount; assert.ok(firstSearches > 0); assert.ok(firstDownloads > 0);
    await service.resolve({ workspaceId, script: cacheScript, localAssets: [], usePexels: true });
    assert.equal(provider.searchCount, firstSearches); assert.equal(provider.downloadCount, firstDownloads);
    const provenance = await db.query<{ provider: string; provider_asset_id: string; provider_file_id: string; asset_id: string }>('select provider,provider_asset_id,provider_file_id,asset_id from external_media_assets where asset_id in (select asset_id from video_workspace_assets where workspace_id=$1)', [workspaceId]);
    assert.ok(provenance.rows.length > 0); assert.equal(provenance.rows[0]?.provider, 'fake-pexels');
    const imported = await db.query<{ metadata: Record<string, unknown> }>('select metadata from assets where id=$1', [provenance.rows[0]!.asset_id]);
    assert.equal(Number(imported.rows[0]?.metadata?.durationMs), 6_000);
  } finally { await db.query('delete from video_workspaces where id=$1', [workspaceId]); await db.end(); await rm(root, { recursive: true, force: true }); }
});

test('closure resolver prefers authentic entities and allows controlled reuse', async () => {
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
    assert.equal(resolved.resolvedAssignments[2]?.selectedAssetId, 'mizan-real'); assert.equal(resolved.resolvedAssignments[2]?.allowAssetReuse, true);
    const planned = buildScriptMontageManifest({ workspaceId: 'closure-workspace', script, sentences: [], assets: [...local, ...resolved.assets.filter((asset) => !local.some((candidate) => candidate.id === asset.id))], resolvedAssignments: resolved.resolvedAssignments, seed: 1, minClipDurationMs: 2_000, maxClipDurationMs: 5_000 });
    assert.equal(planned.manifest.timeline[0]?.matching?.selectedRole, 'AUTHENTIC_ENTITY'); assert.equal(planned.manifest.timeline[0]?.matching?.selectedSource, 'LOCAL'); assert.equal(planned.manifest.timeline[2]?.assetId, 'mizan-real'); assert.equal(planned.manifest.timeline[2]?.matching?.allowAssetReuse, true);
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

test('external retrieval allows controlled reuse after the candidate pool is exhausted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-hybrid-external-reuse-')); const fixture = join(root, 'fixture.mp4'); await writeFile(fixture, 'video');
  const storage = new LocalStorageProvider(join(root, 'storage')); const provider = new FakeExternalVideoProvider(fixture); let index = 0; const service = new HybridMediaService({ importFile: async () => ({ id: `external-${++index}`, projectId: '', checksum: `sha256:${index}`, storageKey: `objects/${index}.mp4`, byteSize: 5, status: 'READY' as const }) } as never, storage, provider);
  try { const result = await service.resolve({ workspaceId: 'external-reuse-workspace', script: '商业合作正在推进。商业合作正在推进。商业合作正在推进。', localAssets: [], usePexels: true, minClipDurationMs: 2_000, maxClipDurationMs: 5_000 }); assert.equal(result.resolvedAssignments.length, 3); assert.equal(result.resolvedAssignments[0]?.allowAssetReuse, undefined); assert.equal(result.resolvedAssignments[1]?.allowAssetReuse, undefined); assert.equal(result.resolvedAssignments[2]?.allowAssetReuse, true); assert.match(result.resolvedAssignments[2]?.reason || '', /受控复用/u); } finally { await rm(root, { recursive: true, force: true }); }
});

test('closure external failure uses a marked generic/entity fallback and counts it once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-hybrid-fallback-')); const fixture = join(root, 'fixture.mp4'); await writeFile(fixture, 'video'); const previous = process.env.CONTENTOS_FAKE_PEXELS_FAILURE; process.env.CONTENTOS_FAKE_PEXELS_FAILURE = '1';
  const storage = new LocalStorageProvider(join(root, 'storage')); const provider = new FakeExternalVideoProvider(fixture); const service = new HybridMediaService({ importFile: async () => ({ id: 'never', projectId: '', checksum: 'sha256:never', storageKey: 'never', byteSize: 5, status: 'READY' as const }) } as never, storage, provider);
  try { const result = await service.resolve({ workspaceId: 'fallback-workspace', script: 'MIZAN正在波兰拓展业务。', localAssets: [{ id: 'generic', storageKey: 'generic', sourcePath: 'generic.mp4', durationMs: 12_000, tags: ['无关'] }], usePexels: true }); assert.equal(result.resolvedAssignments[0]?.entityFallback, true); assert.equal(result.diagnostics.fallbackCount, 1); assert.ok(result.diagnostics.warnings.length > 0); } finally { if (previous === undefined) delete process.env.CONTENTOS_FAKE_PEXELS_FAILURE; else process.env.CONTENTOS_FAKE_PEXELS_FAILURE = previous; await rm(root, { recursive: true, force: true }); }
});

test('final FFmpeg regression renders SCRIPT voice, MIX and Hybrid fake Pexels manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-hybrid-ffmpeg-regression-'));
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'; const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
  try {
    const sourceA = join(root, 'source-a.mp4'); const sourceB = join(root, 'source-b.mp4'); const voice = join(root, 'voice.wav');
    await generateFixtureVideo(sourceA, ffmpegPath, 'blue', 8); await generateFixtureVideo(sourceB, ffmpegPath, 'green', 8); await generateFixtureAudio(voice, ffmpegPath);
    const sentences = [{ index: 0, text: '第一句。', normalizedText: '第一句', durationMs: 2_500 }, { index: 1, text: '第二句。', normalizedText: '第二句', durationMs: 2_500 }];
    const assets = [
      { id: 'script-a', storageKey: 'script-a', sourcePath: sourceA, durationMs: 8_000 },
      { id: 'script-b', storageKey: 'script-b', sourcePath: sourceB, durationMs: 8_000 },
    ];
    const scriptManifest = buildScriptMontageManifest({ projectId: 'ffmpeg-script', script: '第一句。第二句。', sentences, assets, voicePath: voice, seed: 1, minClipDurationMs: 2_000, maxClipDurationMs: 5_000 }).manifest;
    const mixManifest = buildRandomSentenceMontageManifest({ projectId: 'ffmpeg-mix', sentences, assets, seed: 2, minClipDurationMs: 2_000, maxClipDurationMs: 5_000 }).manifest;
    const hybridStorage = new LocalStorageProvider(join(root, 'hybrid-storage')); const hybridObjectKey = 'objects/hybrid.mp4';
    const provider = new FakeExternalVideoProvider(sourceA);
    const hybridAssets = { importFile: async (input: { sourcePath: string }) => { await mkdir(join(hybridStorage.root, 'objects'), { recursive: true }); await copyFile(input.sourcePath, hybridStorage.objectPath(hybridObjectKey)); return { id: 'hybrid-external', storageKey: hybridObjectKey, status: 'READY' as const }; } };
    const hybrid = new HybridMediaService(hybridAssets as never, hybridStorage, provider);
    const hybridSentences = [{ index: 0, text: '商业合作正在推进。', normalizedText: '商业合作正在推进', durationMs: 2_500 }];
    const resolved = await hybrid.resolve({ workspaceId: 'ffmpeg-hybrid', script: hybridSentences[0]!.text, sentences: hybridSentences, localAssets: [], usePexels: true, minClipDurationMs: 2_000, maxClipDurationMs: 5_000 });
    assert.equal(resolved.resolvedAssignments[0]?.selectedSource, 'FAKE_PEXELS');
    const hybridManifest = buildScriptMontageManifest({ workspaceId: 'ffmpeg-hybrid', script: hybridSentences[0]!.text, sentences: hybridSentences, assets: resolved.assets, resolvedAssignments: resolved.resolvedAssignments, voicePath: voice, seed: 3, minClipDurationMs: 2_000, maxClipDurationMs: 5_000 }).manifest;
    const cases = [
      { name: 'script', manifest: scriptManifest, hasAudio: true, expectedDurationMs: 5_000 },
      { name: 'mix', manifest: mixManifest, hasAudio: false, expectedDurationMs: 5_000 },
      { name: 'hybrid', manifest: hybridManifest, hasAudio: true, expectedDurationMs: 2_500 },
    ];
    for (const item of cases) {
      const output = join(root, `${item.name}.mp4`); await renderEditManifest({ manifest: item.manifest, outputPath: output, ffmpegPath, ffprobePath });
      const probe = await probeMedia(output, ffprobePath);
      assert.equal(probe.width, 1_080); assert.equal(probe.height, 1_920); assert.equal(probe.videoCodec, 'h264'); assert.equal(probe.pixelFormat, 'yuv420p'); assert.ok(Math.abs((probe.fps || 0) - item.manifest.canvas.fps) < 0.1);
      assert.equal(probe.audio, item.hasAudio); if (item.hasAudio) assert.equal(probe.audioCodec, 'aac'); assert.ok(Math.abs(probe.durationMs - item.expectedDurationMs) <= 250, `${item.name} duration ${probe.durationMs}ms`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
