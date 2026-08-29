import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { AssetCatalogService, AssetService } from '../../packages/modules/asset/src/index.js';
import { DirectorJobService, DirectorV1Service } from '../../packages/modules/director/src/index.js';
import { AIService, FakeAIProvider, PromptRegistry } from '../../packages/modules/ai/src/index.js';
import { ApprovalService } from '../../packages/modules/approval/src/index.js';
import { JobRunner, JobService } from '../../packages/modules/job/src/index.js';
import { DirectorVideoService, VideoService } from '../../packages/modules/video/src/index.js';
import { FakePublisherAdapter, FakePublisherService, PublisherService } from '../../packages/modules/publisher/src/index.js';
import type { PublisherAdapter, PublisherContext, PublishResult, PublishSnapshot, ExternalStateResult, AuthResult, PlatformCapabilityProfile } from '../../packages/contracts/src/index.js';
import { LocalStorageProvider } from '../../packages/infrastructure/storage/src/index.js';
import { generateFixtureAudio, generateFixtureVideo, probeMedia } from '../../packages/infrastructure/ffmpeg/src/index.js';
import { createDirectorWorker } from '../../workers/director-worker/src/main.js';
import { createVideoJobHandler } from '../../workers/video-worker/src/video-handler.js';
import { createPublisherWorker } from '../../workers/publisher-worker/src/main.js';
import type { ModelProfile } from '../../packages/contracts/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
const fontFile = process.env.FFMPEG_FONT_FILE || 'C:\\Windows\\Fonts\\msyh.ttc';
const profile: ModelProfile = { id: 'fake-integration-profile', providerId: 'fake', modelId: 'fake-zh-v1', displayName: 'Fake Integration', capabilities: ['TEXT', 'STRUCTURED'], maxInputCharacters: 20_000, maxOutputTokens: 2_000, enabled: true };

async function cleanupProject(db: Awaited<ReturnType<typeof createDatabase>>, projectId: string): Promise<void> {
  await db.query('delete from publisher_publication_states where account_id in (select id from publisher_accounts where project_id = $1)', [projectId]);
  await db.query('update publisher_requests set current_revision_id = null where project_id = $1', [projectId]);
  await db.query('delete from publisher_external_posts where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_attempts where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_request_revisions where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_requests where project_id = $1', [projectId]);
  await db.query('delete from approval_decisions where project_id = $1', [projectId]);
  await db.query('delete from renders where project_id = $1', [projectId]);
  await db.query('delete from edit_manifests where project_id = $1', [projectId]);
  await db.query('delete from director_project_state where project_id = $1', [projectId]);
  await db.query('delete from director_storyboard_revisions where project_id = $1', [projectId]);
  await db.query('delete from director_storyboards where project_id = $1', [projectId]);
  await db.query('delete from director_script_revisions where project_id = $1', [projectId]);
  await db.query('delete from director_scripts where project_id = $1', [projectId]);
  await db.query('delete from director_briefs where project_id = $1', [projectId]);
  await db.query('delete from ai_runs where project_id = $1', [projectId]);
  await db.query('delete from job_events where job_id in (select id from jobs where project_id = $1)', [projectId]);
  await db.query('delete from job_attempts where job_id in (select id from jobs where project_id = $1)', [projectId]);
  await db.query('delete from jobs where project_id = $1', [projectId]);
  await db.query('delete from publisher_accounts where project_id = $1', [projectId]);
  await db.query('delete from project_assets where project_id = $1', [projectId]);
  await db.query('delete from assets where project_id = $1', [projectId]);
  await db.query('delete from content_projects where id = $1', [projectId]);
}

class FlakyNetworkAdapter implements PublisherAdapter {
  private calls = 0;
  capabilities(): PlatformCapabilityProfile { return { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false }; }
  async authenticate(_context: PublisherContext): Promise<AuthResult> { return { status: 'AUTHENTICATED' }; }
  async publish(_context: PublisherContext, _snapshot: PublishSnapshot): Promise<PublishResult> {
    this.calls += 1;
    return this.calls === 1 ? { status: 'FAILED', failure: { code: 'NETWORK_ERROR', classification: 'RETRYABLE', message: 'temporary network failure' } } : { status: 'PUBLISHED', externalPostId: 'fake-retry-post' };
  }
  async reconcile(_context: PublisherContext, _idempotencyKey: string): Promise<ExternalStateResult> { return { status: 'NOT_FOUND' }; }
}

async function publisherFixture(db: Awaited<ReturnType<typeof createDatabase>>, outcome: ConstructorParameters<typeof FakePublisherAdapter>[0] | PublisherAdapter = 'SUCCESS') {
  const project = await new ProjectService(db).create(`Publisher integration ${randomUUID()}`);
  const assetId = `asset-publisher-integration-${randomUUID()}`;
  const checksum = `sha256:${'a'.repeat(64)}`;
  await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, project.id, 'VIDEO_RENDER', checksum, 100, `renders/${assetId}.mp4`, 'READY', { width: 1080, height: 1920 }]);
  const publisher = new PublisherService(db);
  const account = await publisher.createAccount({ projectId: project.id, platformId: 'fake-platform', displayName: 'Fake Integration', credentialRef: 'fake-credential:integration', profileKey: `profile-${randomUUID()}`, status: 'READY', capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false } });
  const request = await publisher.createRequest({ projectId: project.id, accountId: account.id, idempotencyKey: `publisher-integration-${randomUUID()}`, correlationId: `correlation-${randomUUID()}`, revision: { assetId, assetChecksum: checksum, title: '集成验收视频', description: 'ContentOS 集成验收', desiredPublishAt: null, createdBy: 'integration-test' } });
  await publisher.transitionRequest(request.request.id, 'QUEUED');
  const jobs = new JobService(db);
  const jobId = `job-publisher-integration-${randomUUID()}`;
  const payload = await publisher.buildPublishJobPayload(project.id, request.request.id, jobId, null);
  const job = await jobs.create({ id: jobId, type: 'PUBLISH', projectId: project.id, payload, idempotencyKey: `job-publisher-integration-${randomUUID()}`, maxAttempts: 3 });
  const root = await mkdtemp(join(tmpdir(), 'contentos-integration-publisher-'));
  const adapter = typeof outcome === 'string' ? new FakePublisherAdapter(outcome) : outcome;
  return { project, assetId, checksum, account, request, jobs, publisher, job, root, fake: new FakePublisherService(root, adapter) };
}

test('ContentOS public services compose Director, Video, Approval, Publisher and Project status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-integration-e2e-'));
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create(`ContentOS full integration ${randomUUID()}`);
  const jobs = new JobService(db);
  const director = new DirectorV1Service(db);
  const directorJobs = new DirectorJobService(jobs);
  const ai = new AIService(db, new FakeAIProvider(), new PromptRegistry(), profile);
  const directorWorker = createDirectorWorker({ jobs, director, ai, modelProfile: profile });
  await directorWorker.start();
  const storage = new LocalStorageProvider(join(root, 'storage'));
  const assets = new AssetService(db, storage, (path) => probeMedia(path, ffprobePath));
  let projectId = project.id;
  try {
    const brief = await director.createBrief(project.id, { topic: '门店经营', targetPlatform: 'douyin', channelPositioning: '经营知识栏目', targetDurationSeconds: 4, contentType: 'knowledge', audience: '小微商家', coreThesis: '先验证，再扩大投入。', tone: '清晰', referenceMaterial: '集成验收材料', mustInclude: ['反例'], mustAvoid: ['夸大'], requirements: {}, createdBy: 'operator' });
    const script = await director.createScript(project.id, brief.id);
    const scriptJob = await directorJobs.createScriptGeneration({ projectId: project.id, briefId: brief.id, scriptAggregateId: script.id, correlationId: `script-${randomUUID()}` });
    await directorWorker.execute('DIRECTOR_GENERATE_SCRIPT', { jobId: scriptJob.id });
    const acceptedScript = await director.acceptScript(project.id, (await director.listScriptRevisions(project.id))[0]!.id);
    const storyboard = await director.createStoryboard(project.id);
    const storyboardJob = await directorJobs.createStoryboardGeneration({ projectId: project.id, scriptRevisionId: acceptedScript.id, storyboardAggregateId: storyboard.id, correlationId: `storyboard-${randomUUID()}` });
    await directorWorker.execute('DIRECTOR_GENERATE_STORYBOARD', { jobId: storyboardJob.id });
    const approvedStoryboard = await director.approveStoryboard(project.id, (await director.listStoryboardRevisions(project.id))[0]!.id);
    const sourcePaths = await Promise.all(['red', 'green'].map(async (color) => { const path = join(root, `${color}.mp4`); await generateFixtureVideo(path, ffmpegPath, color); return assets.importFile({ projectId: project.id, sourcePath: path, kind: 'VIDEO' }); }));
    const voicePath = join(root, 'voice.wav'); await generateFixtureAudio(voicePath, ffmpegPath); const voice = await assets.importFile({ projectId: project.id, sourcePath: voicePath, kind: 'AUDIO' });
    const video = new VideoService(db, storage, jobs, new AssetCatalogService(db));
    const videoJob = await new DirectorVideoService(director, video).createVideoJob(project.id, { videoAssetIds: sourcePaths.map((asset) => asset.id), voiceAssetId: voice.id, targetDurationMs: 3_000, subtitleText: 'ContentOS Integration', seed: 7 });
    const renderResult = await new JobRunner(jobs, 'integration-video-worker').run(videoJob.id, createVideoJobHandler({ db, storage, assets, jobs, video, ffmpegPath, ffprobePath, fontFile }));
    assert.equal(renderResult.state, 'SUCCEEDED');
    const rendered = renderResult.result as { renderId: string; outputAssetId: string };
    const renderApproval = new ApprovalService(db);
    await renderApproval.create({ projectId: project.id, targetType: 'RENDER', targetId: rendered.renderId, targetRevisionId: rendered.outputAssetId, status: 'PENDING', approver: 'operator' });
    await renderApproval.approve(project.id, 'RENDER', rendered.renderId, rendered.outputAssetId, 'operator');
    const output = await db.query<{ checksum: string }>('select checksum from assets where id = $1', [rendered.outputAssetId]);
    const publisher = new PublisherService(db);
    const account = await publisher.createAccount({ projectId: project.id, platformId: 'fake-platform', displayName: 'Fake Account', credentialRef: 'fake-credential:full-flow', profileKey: `profile-${randomUUID()}`, status: 'READY', capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false } });
    const request = await publisher.createRequest({ projectId: project.id, accountId: account.id, idempotencyKey: `full-publish-${randomUUID()}`, correlationId: `full-correlation-${randomUUID()}`, revision: { assetId: rendered.outputAssetId, assetChecksum: output.rows[0]!.checksum, title: 'ContentOS 全链路', description: 'Director 到 Publisher', desiredPublishAt: null, createdBy: 'operator' } });
    const publishApproval = new ApprovalService(db);
    await publishApproval.create({ projectId: project.id, targetType: 'PUBLISH', targetId: request.request.id, targetRevisionId: request.revision.id, status: 'PENDING', approver: 'operator' });
    await publishApproval.approve(project.id, 'PUBLISH', request.request.id, request.revision.id, 'operator');
    await publisher.transitionRequest(request.request.id, 'QUEUED');
    const publishJobId = `job-full-publish-${randomUUID()}`;
    const payload = await publisher.buildPublishJobPayload(project.id, request.request.id, publishJobId, null);
    const publishJob = await jobs.create({ id: publishJobId, type: 'PUBLISH', projectId: project.id, payload, idempotencyKey: `full-publish-job-${randomUUID()}`, maxAttempts: 3 });
    const fakeRoot = await mkdtemp(join(tmpdir(), 'contentos-full-fake-'));
    try {
      const worker = createPublisherWorker({ service: publisher, jobs, projects: new ProjectService(db), assets: new AssetCatalogService(db), fakePublisher: new FakePublisherService(fakeRoot), workerId: 'full-integration-publisher' });
      await worker.start();
      const publishResult = await worker.execute('PUBLISH', { jobId: publishJob.id }) as { state: string };
      assert.equal(publishResult.state, 'SUCCEEDED');
      assert.equal((await publisher.getRequest(request.request.id))?.status, 'PUBLISHED');
      assert.equal((await new ProjectService(db).get(project.id))?.status, 'PUBLISHED');
      assert.equal((await db.query('select id from publisher_external_posts where request_id = $1', [request.request.id])).rowCount, 1);
      await worker.shutdown('integration');
    } finally { await rm(fakeRoot, { recursive: true, force: true }); }
    assert.equal((await db.query('select status from renders where id = $1', [rendered.renderId])).rows[0]?.status, 'SUCCEEDED');
    assert.equal((await probeMedia(storage.objectPath((await db.query<{ storage_key: string }>('select storage_key from assets where id = $1', [rendered.outputAssetId])).rows[0]!.storage_key), ffprobePath)).format, 'mp4');
  } finally { await cleanupProject(db, projectId); await db.end(); await rm(root, { recursive: true, force: true }); }
});

test('ContentOS Publisher network failure retries and then succeeds', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); let projectId = ''; let root = '';
  try {
    const data = await publisherFixture(db, new FlakyNetworkAdapter()); projectId = data.project.id; root = data.root;
    const worker = createPublisherWorker({ service: data.publisher, jobs: data.jobs, projects: new ProjectService(db), assets: new AssetCatalogService(db), fakePublisher: data.fake, workerId: 'integration-network' }); await worker.start();
    const first = await worker.execute('PUBLISH', { jobId: data.job.id }) as { state: string }; assert.equal(first.state, 'RETRY_WAIT'); assert.equal((await data.publisher.getRequest(data.request.request.id))?.status, 'FAILED');
    await data.jobs.requeue(data.job.id); const second = await worker.execute('PUBLISH', { jobId: data.job.id }) as { state: string }; assert.equal(second.state, 'SUCCEEDED'); assert.equal((await data.publisher.getRequest(data.request.request.id))?.status, 'PUBLISHED'); await worker.shutdown('integration');
  } finally { if (projectId) await cleanupProject(db, projectId); await db.end(); }
});

test('ContentOS Publisher auth expiry is human action and does not auto-retry', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); let projectId = '';
  try {
    const data = await publisherFixture(db, 'AUTH_EXPIRED'); projectId = data.project.id;
    const worker = createPublisherWorker({ service: data.publisher, jobs: data.jobs, projects: new ProjectService(db), assets: new AssetCatalogService(db), fakePublisher: data.fake, workerId: 'integration-auth' }); await worker.start();
    const result = await worker.execute('PUBLISH', { jobId: data.job.id }) as { state: string }; assert.equal(result.state, 'FAILED');
    const aggregate = await data.publisher.getRequestAggregate(projectId, data.request.request.id); assert.equal(aggregate?.request.status, 'FAILED'); assert.equal(aggregate?.nextAction, 'NEEDS_HUMAN_ACTION'); assert.equal((await data.jobs.get(data.job.id))?.state, 'FAILED'); await worker.shutdown('integration');
  } finally { if (projectId) await cleanupProject(db, projectId); await db.end(); }
});

test('ContentOS Publisher unknown side effect reconciles to one external post', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); let projectId = '';
  try {
    const data = await publisherFixture(db, 'BROWSER_CRASH'); projectId = data.project.id;
    const worker = createPublisherWorker({ service: data.publisher, jobs: data.jobs, projects: new ProjectService(db), assets: new AssetCatalogService(db), fakePublisher: data.fake, workerId: 'integration-unknown' }); await worker.start();
    const first = await worker.execute('PUBLISH', { jobId: data.job.id }) as { state: string }; assert.equal(first.state, 'SUCCEEDED'); assert.equal((await data.publisher.getRequest(data.request.request.id))?.status, 'RECONCILING');
    const reconcileJob = await data.jobs.getByIdempotencyKey(`publisher:reconcile:${data.request.request.id}:${(data.job.payload as { revisionId: string }).revisionId}`); assert.ok(reconcileJob);
    const second = await worker.execute('PUBLISH_RECONCILE', { jobId: reconcileJob!.id }) as { state: string }; assert.equal(second.state, 'SUCCEEDED'); assert.equal((await data.publisher.getRequest(data.request.request.id))?.status, 'PUBLISHED');
    assert.equal((await db.query('select id from publisher_external_posts where request_id = $1', [data.request.request.id])).rowCount, 1); await worker.shutdown('integration');
  } finally { if (projectId) await cleanupProject(db, projectId); await db.end(); }
});
