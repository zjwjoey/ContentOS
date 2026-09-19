import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeExternalVideoProvider, HybridMediaService, planVisuals, type ExternalVideoProvider } from '../../packages/modules/video/src/index.js';
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
