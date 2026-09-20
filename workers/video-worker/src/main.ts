import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { WorkerRuntime } from '../../../packages/shared/src/worker-runtime.js';
import { JobRunner } from '../../../packages/modules/job/src/index.js';
import { JobService } from '../../../packages/modules/job/src/index.js';
import { AssetCatalogService, AssetService, LocalMediaSourceService } from '../../../packages/modules/asset/src/index.js';
import { VideoService, createExternalVideoProvider } from '../../../packages/modules/video/src/index.js';
import { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { probeMedia } from '../../../packages/infrastructure/ffmpeg/src/index.js';
import { createDatabase } from '../../../packages/database/src/index.js';
import { loadConfig } from '../../../packages/config/src/index.js';
import { LocalPathAccessService } from '../../../packages/modules/local-path/src/index.js';
import { createEditExportJobHandler, createEditPrepareJobHandler, createJianyingImportJobHandler, createLocalMediaScanJobHandler, createScriptPlanJobHandler, createVisualAnalysisJobHandler, createVideoJobHandler, createVideoLeaseCancellationHandler, type VideoHandlerDeps } from './video-handler.js';

export interface VideoWorkerOptions extends VideoHandlerDeps { workerId?: string; reconcileIntervalMs?: number; pollIntervalMs?: number; concurrency?: number; }

class VideoWorkerRuntime extends WorkerRuntime {
  private reconciliationTimer: NodeJS.Timeout | null = null;
  private consumptionTimer: NodeJS.Timeout | null = null;
  private activeReconciliation: Promise<void> | null = null;
  private activeConsumption: Promise<void> | null = null;
  constructor(workerId: string, private readonly reconcile: () => Promise<unknown>, private readonly consume: () => Promise<unknown>, private readonly reconcileIntervalMs: number, private readonly pollIntervalMs: number) { super(workerId); }
  private runReconciliation(): Promise<void> {
    if (this.activeReconciliation) return this.activeReconciliation;
    this.activeReconciliation = this.reconcile()
      .then(() => undefined)
      .catch((error: unknown) => { console.error(JSON.stringify({ level: 'error', event: 'video.lease_reconcile_failed', code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNKNOWN' })); })
      .finally(() => { this.activeReconciliation = null; });
    return this.activeReconciliation;
  }
  private runConsumption(): Promise<void> {
    if (this.activeConsumption) return this.activeConsumption;
    this.activeConsumption = this.consume()
      .then(() => undefined)
      .catch((error: unknown) => { console.error(JSON.stringify({ level: 'error', event: 'video.consume_failed', code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNKNOWN' })); })
      .finally(() => { this.activeConsumption = null; });
    return this.activeConsumption;
  }
  override async start(): Promise<void> {
    await this.runReconciliation();
    await super.start();
    this.reconciliationTimer = setInterval(() => { void this.runReconciliation(); }, this.reconcileIntervalMs);
    this.consumptionTimer = setInterval(() => { void this.runConsumption(); }, this.pollIntervalMs);
    this.reconciliationTimer.unref();
    this.consumptionTimer.unref();
    void this.runConsumption();
  }
  override async shutdown(signal: string): Promise<void> {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    if (this.consumptionTimer) clearInterval(this.consumptionTimer);
    this.reconciliationTimer = null;
    this.consumptionTimer = null;
    if (this.activeReconciliation) await this.activeReconciliation;
    if (this.activeConsumption) await this.activeConsumption;
    await super.shutdown(signal);
  }
}

/**
 * Repairs the small crash window between durable item creation and enqueueing
 * its first job. The item row is the source of truth; a restarted worker can
 * safely recreate the idempotent prepare job without losing the batch.
 */
async function recoverEditWorkbenchItems(options: VideoWorkerOptions, limit: number): Promise<void> {
  const client = await options.db.connect();
  try {
    await client.query('begin');
    const rows = (await client.query(`select i.id, i.batch_id, i.workspace_id, i.prepare_job_id, p.state as prepare_state
      from edit_batch_items i left join jobs p on p.id = i.prepare_job_id
      where i.job_id is null and i.manifest_id is null and (i.prepare_job_id is null or p.state in ('FAILED','CANCELLED'))
        and i.state in ('QUEUED','PREPARING','RUNNING')
      order by i.created_at, i.id
      for update of i skip locked limit $1`, [Math.max(1, limit)])).rows as Array<{ id: string; batch_id: string; workspace_id: string; prepare_job_id?: string; prepare_state?: string }>;
    for (const row of rows) {
      const job = (await client.query(`insert into jobs (id,project_id,workspace_id,type,state,idempotency_key,payload,max_attempts)
        values ($1,null,$2,'EDIT_PREPARE_ITEM','QUEUED',$3,$4,3)
        on conflict (idempotency_key) do update set id=jobs.id
        returning id`, [`job-${randomUUID()}`, row.workspace_id, row.prepare_job_id ? `edit-prepare:${row.id}:retry:${row.prepare_job_id}` : `edit-prepare:${row.id}`, { batchId: row.batch_id, itemId: row.id, workspaceId: row.workspace_id }])).rows[0] as { id: string };
      await client.query("update edit_batch_items set prepare_job_id=$2,state='PREPARING',updated_at=now() where id=$1 and job_id is null", [row.id, job.id]);
    }
    await client.query('commit');
  } catch (error) { await client.query('rollback').catch(() => undefined); throw error; }
  finally { client.release(); }

  const prepared = (await options.db.query(`select i.id, p.result->>'manifestId' as manifest_id, p.result->>'renderJobId' as job_id
    from edit_batch_items i join jobs p on p.id = i.prepare_job_id
    where i.job_id is null and i.manifest_id is null and p.state='SUCCEEDED'
      and p.result->>'manifestId' is not null and p.result->>'renderJobId' is not null
    order by i.updated_at, i.id limit $1`, [Math.max(1, limit)])).rows as Array<{ id: string; manifest_id: string; job_id: string }>;
  for (const row of prepared) await options.db.query("update edit_batch_items set manifest_id=$2,job_id=$3,state='RENDERING',updated_at=now() where id=$1 and job_id is null", [row.id, row.manifest_id, row.job_id]);

  const orphaned = (await options.db.query(`select id, workspace_id, manifest_id
    from edit_batch_items
    where manifest_id is not null and job_id is null and state in ('RUNNING','RENDERING')
    order by updated_at, id limit $1`, [Math.max(1, limit)])).rows as Array<{ id: string; workspace_id: string; manifest_id: string }>;
  for (const row of orphaned) {
    try {
      const job = await options.video.createManifestRenderJobForWorkspace(row.workspace_id, row.manifest_id, `edit-item-${row.id}`);
      await options.db.query("update edit_batch_items set job_id=$2,state='RENDERING',updated_at=now() where id=$1 and job_id is null", [row.id, job.id]);
    } catch (error) {
      await options.db.query("update edit_batch_items set error=$2,updated_at=now() where id=$1 and job_id is null", [row.id, { code: 'EDIT_RENDER_RECOVERY_FAILED', message: error instanceof Error ? error.message : '渲染任务恢复失败' }]).catch(() => undefined);
    }
  }

  const retrying = (await options.db.query(`select i.id, i.workspace_id, i.manifest_id, i.job_id
    from edit_batch_items i join jobs j on j.id = i.job_id
    where i.manifest_id is not null and i.job_id is not null and i.state = 'RUNNING'
      and j.state in ('FAILED','BLOCKED')
    order by i.updated_at, i.id limit $1`, [Math.max(1, limit)])).rows as Array<{ id: string; workspace_id: string; manifest_id: string; job_id: string }>;
  for (const row of retrying) {
    try {
      const job = await options.video.createManifestRenderJobForWorkspace(row.workspace_id, row.manifest_id, `edit-retry:${row.id}:${row.job_id}`);
      await options.db.query("update edit_batch_items set job_id=$2,state='RENDERING',error=null,updated_at=now() where id=$1 and state='RUNNING' and job_id=$3", [row.id, job.id, row.job_id]);
    } catch (error) {
      await options.db.query("update edit_batch_items set state='FAILED',error=$2,updated_at=now() where id=$1 and state='RUNNING' and job_id=$3", [row.id, { code: 'EDIT_RENDER_RECOVERY_FAILED', message: error instanceof Error ? error.message : '渲染任务恢复失败' }, row.job_id]).catch(() => undefined);
    }
  }
}

export function createVideoWorker(options?: VideoWorkerOptions): WorkerRuntime {
  if (!options) {
    const runtime = new WorkerRuntime('video-worker');
    runtime.register('video.render', async () => ({ status: 'NOT_IMPLEMENTED_STAGE_4_BOOTSTRAP' }));
    return runtime;
  }
  const reconcileIntervalMs = options.reconcileIntervalMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const concurrency = options.concurrency ?? 1;
  if (reconcileIntervalMs <= 0 || pollIntervalMs <= 0 || concurrency <= 0) throw new Error('Video worker intervals and concurrency must be positive');
  const runner = new JobRunner(options.jobs, options.workerId || 'video-worker');
  const handler = createVideoJobHandler(options);
  const prepareHandler = createEditPrepareJobHandler(options);
  const exportHandler = createEditExportJobHandler(options);
  const scriptPlanHandler = createScriptPlanJobHandler(options);
  const localMediaHandler = createLocalMediaScanJobHandler(options);
  const visualAnalysisHandler = createVisualAnalysisJobHandler(options);
  const jianyingImportHandler = createJianyingImportJobHandler(options);
  const videoCancellation = createVideoLeaseCancellationHandler(options.video, options.storage);
  const recoverCancellation = async (job: Parameters<typeof videoCancellation>[0], scope: Parameters<typeof videoCancellation>[1]): Promise<boolean> => {
    if (job.type === 'LOCAL_MEDIA_SCAN') {
      const payload = job.payload as { scanId?: string };
      if (options.localMedia && payload.scanId) await options.localMedia.failScan(payload.scanId, { code: 'LOCAL_MEDIA_SCAN_CANCELLED', message: 'Scan cancelled after lease expiry' }, 'CANCELLED');
      return true;
    }
    if (job.type === 'EDIT_PREPARE_ITEM') {
      const payload = job.payload as { itemId?: string };
      if (payload.itemId) await options.db.query("update edit_batch_items set state='FAILED',error=$2,updated_at=now() where id=$1", [payload.itemId, { code: 'EDIT_PREPARE_CANCELLED', message: '准备任务租约失效，已停止' }]);
      return true;
    }
    if (job.type === 'EDIT_EXPORT') {
      const payload = job.payload as { exportId?: string };
      if (payload.exportId) await options.db.query("update edit_exports set status='FAILED',error=$2,finished_at=now() where id=$1", [payload.exportId, { code: 'EDIT_EXPORT_CANCELLED', message: '导出任务租约失效，已停止' }]);
      return true;
    }
    if (job.type === 'EDIT_SCRIPT_PLAN') {
      const payload = job.payload as { planId?: string };
      if (payload.planId) await options.db.query("update edit_script_plans set status='FAILED',updated_at=now() where id=$1", [payload.planId]);
      return true;
    }
    if (job.type === 'ANALYZE_ASSET_VISUAL' || job.type === 'GENERATE_REPRESENTATIVE_FRAMES' || job.type === 'IMPORT_JIANYING_DRAFT') return true;
    return videoCancellation(job, scope);
  };
  const consume = async (): Promise<void> => {
    const runnable = await options.jobs.listRunnable(['VIDEO_RENDER', 'LOCAL_MEDIA_SCAN', 'EDIT_PREPARE_ITEM', 'EDIT_EXPORT', 'EDIT_SCRIPT_PLAN', 'ANALYZE_ASSET_VISUAL', 'GENERATE_REPRESENTATIVE_FRAMES', 'IMPORT_JIANYING_DRAFT'], concurrency);
    await Promise.all(runnable.map((job) => runner.run(job.id, job.type === 'LOCAL_MEDIA_SCAN' ? localMediaHandler : job.type === 'EDIT_PREPARE_ITEM' ? prepareHandler : job.type === 'EDIT_EXPORT' ? exportHandler : job.type === 'EDIT_SCRIPT_PLAN' ? scriptPlanHandler : job.type === 'ANALYZE_ASSET_VISUAL' || job.type === 'GENERATE_REPRESENTATIVE_FRAMES' ? visualAnalysisHandler : job.type === 'IMPORT_JIANYING_DRAFT' ? jianyingImportHandler : handler)));
  };
  const reconcile = async (): Promise<void> => { await options.jobs.reconcileExpiredLeases(new Date(), recoverCancellation); await recoverEditWorkbenchItems(options, concurrency * 4); };
  const runtime = new VideoWorkerRuntime(options.workerId || 'video-worker', reconcile, consume, reconcileIntervalMs, pollIntervalMs);
  runtime.register('video.render', async (payload) => {
    const jobId = payload && typeof payload === 'object' ? (payload as { jobId?: unknown }).jobId : undefined;
    if (typeof jobId !== 'string' || !jobId) throw new Error('Video delivery requires jobId');
    return runner.run(jobId, handler);
  });
  runtime.register('local_media.scan', async (payload) => {
    const jobId = payload && typeof payload === 'object' ? (payload as { jobId?: unknown }).jobId : undefined;
    if (typeof jobId !== 'string' || !jobId) throw new Error('Local media scan delivery requires jobId');
    return runner.run(jobId, localMediaHandler);
  });
  runtime.register('edit.prepare_item', async (payload) => {
    const jobId = payload && typeof payload === 'object' ? (payload as { jobId?: unknown }).jobId : undefined;
    if (typeof jobId !== 'string' || !jobId) throw new Error('Edit prepare delivery requires jobId');
    return runner.run(jobId, prepareHandler);
  });
  runtime.register('edit.export', async (payload) => {
    const jobId = payload && typeof payload === 'object' ? (payload as { jobId?: unknown }).jobId : undefined;
    if (typeof jobId !== 'string' || !jobId) throw new Error('Edit export delivery requires jobId');
    return runner.run(jobId, exportHandler);
  });
  return runtime;
}

if (basename(process.argv[1] ?? '') === 'main.ts') {
  const config = loadConfig();
  const db = await createDatabase(config.databaseUrl);
  const storage = new LocalStorageProvider(config.storageRoot);
  const jobs = new JobService(db);
  const localPathAccess = new LocalPathAccessService({ db });
  const assets = new AssetService(db, storage, (path) => probeMedia(path, config.ffprobePath));
  const video = new VideoService(db, storage, jobs, new AssetCatalogService(db), localPathAccess);
  const worker = createVideoWorker({ db, storage, jobs, assets, video, localPathAccess, mediaProvider: createExternalVideoProvider(), localMedia: new LocalMediaSourceService({ db, thumbnailRoot: `${storage.root}/thumbnails`, pathAccess: localPathAccess }), ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath, fontFile: config.ffmpegFontFile, concurrency: config.videoWorkerConcurrency });
  const stop = async (signal: string): Promise<void> => { await worker.shutdown(signal); await db.end(); };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
  await worker.start();
  console.log(JSON.stringify(worker.health()));
}
