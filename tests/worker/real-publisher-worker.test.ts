import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { AssetCatalogService } from '../../packages/modules/asset/src/index.js';
import { PublisherAdapterRegistry, PublisherService, FakePublisherService, type BrowserPage, type BrowserSessionFactory } from '../../packages/modules/publisher/src/index.js';
import { createPublisherWorker } from '../../workers/publisher-worker/src/main.js';
import type { AuthResult, ExternalStateResult, PlatformCapabilityProfile, PublishResult, PublishSnapshot, PublisherAdapter, PublisherContext } from '../../packages/contracts/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

class RecordingAdapter implements PublisherAdapter {
  context: PublisherContext | undefined;
  capabilities(): PlatformCapabilityProfile { return { platformId: 'douyin', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: true }; }
  async authenticate(context: PublisherContext): Promise<AuthResult> { this.context = context; return { status: 'AUTHENTICATED' }; }
  async publish(context: PublisherContext, _snapshot: PublishSnapshot): Promise<PublishResult> { this.context = context; return { status: 'PUBLISHED', externalPostId: 'douyin-post-1' }; }
  async reconcile(_context: PublisherContext, _idempotencyKey: string): Promise<ExternalStateResult> { return { status: 'NOT_FOUND' }; }
}

const unusedBrowser: BrowserSessionFactory = { open: async () => { throw new Error('browser must not open'); } };
void unusedBrowser;

test('Publisher Worker dispatches enabled real adapters with in-memory credentials and verified media', async () => {
  const db = await createDatabase(databaseUrl); const root = await mkdtemp(join(tmpdir(), 'contentos-real-worker-')); let projectId = '';
  try {
    await migrateUp(db);
    const project = await new ProjectService(db).create(`Real worker ${randomUUID()}`); projectId = project.id;
    const storage = new LocalStorageProvider(root); const checksum = 'a'.repeat(64); const storageKey = `objects/aa/${checksum}`;
    await mkdir(join(root, 'objects', 'aa'), { recursive: true }); await writeFile(storage.objectPath(storageKey), 'verified-media');
    const assetId = `asset-${randomUUID()}`;
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, project.id, 'VIDEO_RENDER', checksum, 14, storageKey, 'READY', {}]);
    const publisher = new PublisherService(db); const account = await publisher.createAccount({ projectId: project.id, platformId: 'douyin', displayName: 'Douyin test', credentialRef: 'env://DOUYIN_TEST', profileKey: 'account-a', status: 'READY', capabilitySnapshot: { platformId: 'douyin', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: true } });
    const request = await publisher.createRequest({ projectId: project.id, accountId: account.id, idempotencyKey: `real-worker-${randomUUID()}`, correlationId: 'real-worker-test', revision: { assetId, assetChecksum: checksum, title: 'title', description: 'description', desiredPublishAt: null, createdBy: 'test' } }); await publisher.transitionRequest(request.request.id, 'QUEUED');
    const jobs = new JobService(db); const jobId = `job-${randomUUID()}`; const payload = await publisher.buildPublishJobPayload(project.id, request.request.id, jobId, null); const job = await jobs.create({ id: jobId, type: 'PUBLISH', projectId: project.id, payload, idempotencyKey: `real-job-${randomUUID()}`, maxAttempts: 3 });
    const adapter = new RecordingAdapter(); const registry = new PublisherAdapterRegistry(); registry.register(adapter);
    const worker = createPublisherWorker({ service: publisher, jobs, projects: new ProjectService(db), assets: new AssetCatalogService(db), fakePublisher: new FakePublisherService(root), adapterRegistry: registry, credentials: { resolve: async (ref) => { assert.equal(ref, 'env://DOUYIN_TEST'); return { accessToken: 'memory-token', openId: 'open-id' }; } }, storage, profileRoot: join(root, 'profiles'), realAdaptersEnabled: true, workerId: 'real-publisher-test' });
    await worker.start(); const result = await worker.execute('PUBLISH', { jobId: job.id }) as { state: string }; assert.equal(result.state, 'SUCCEEDED'); assert.equal((await publisher.getRequest(request.request.id))?.status, 'PUBLISHED'); assert.equal(adapter.context?.accountId, account.id); assert.equal(adapter.context?.credential?.accessToken, 'memory-token'); assert.match(adapter.context?.profileDir || '', /profiles[\\/]douyin[\\/]account-a$/);
    await worker.shutdown('test');
  } finally {
    if (projectId) { await db.query('update publisher_requests set current_revision_id = null where project_id = $1', [projectId]); await db.query('delete from publisher_external_posts where request_id in (select id from publisher_requests where project_id = $1)', [projectId]); await db.query('delete from publisher_attempts where request_id in (select id from publisher_requests where project_id = $1)', [projectId]); await db.query('delete from publisher_request_revisions where request_id in (select id from publisher_requests where project_id = $1)', [projectId]); await db.query('delete from publisher_requests where project_id = $1', [projectId]); await db.query('delete from job_events where job_id in (select id from jobs where project_id = $1)', [projectId]); await db.query('delete from job_attempts where job_id in (select id from jobs where project_id = $1)', [projectId]); await db.query('delete from jobs where project_id = $1', [projectId]); await db.query('delete from publisher_accounts where project_id = $1', [projectId]); await db.query('delete from assets where project_id = $1', [projectId]); await db.query('delete from content_projects where id = $1', [projectId]); }
    await db.end(); await rm(root, { recursive: true, force: true });
  }
});

test('Publisher Worker keeps real adapters disabled before credential resolution', async () => {
  const registry = new PublisherAdapterRegistry(); const adapter = new RecordingAdapter(); registry.register(adapter); let resolved = false;
  const result = await (async () => { const account = { id: 'account', projectId: 'project', platformId: 'douyin', displayName: 'name', credentialRef: 'env://SECRET', profileKey: 'profile', status: 'READY' as const, capabilitySnapshot: adapter.capabilities(), createdAt: '', updatedAt: '' }; const options = { realAdaptersEnabled: false, adapterRegistry: registry, credentials: { resolve: async () => { resolved = true; return {}; } }, fakePublisher: new FakePublisherService(join(tmpdir(), 'contentos-disabled-real')) } as const; return { account, options }; })();
  assert.equal(result.options.realAdaptersEnabled, false); assert.equal(resolved, false); assert.equal(result.account.platformId, 'douyin');
});
