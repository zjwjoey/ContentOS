import type { JobService, JobLeaseRecoveryHandler } from '../../../packages/modules/job/src/index.js';
import { WorkerRuntime } from '../../../packages/shared/src/worker-runtime.js';
import { DIRECTOR_GENERATE_SCRIPT, DIRECTOR_GENERATE_STORYBOARD } from '../../../packages/modules/director/src/director-job-service.js';
import { createDirectorJobHandler, type DirectorWorkerDependencies } from './handler.js';
import { basename } from 'node:path';

export type { DirectorWorkerDependencies } from './handler.js';


export const directorLeaseRecoveryHandler: JobLeaseRecoveryHandler = async (job) => [DIRECTOR_GENERATE_SCRIPT, DIRECTOR_GENERATE_STORYBOARD].some((type) => type === job.type); // This owner has no durable RUNNING record to settle.

class DirectorWorkerRuntime extends WorkerRuntime {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  constructor(workerId: string, private readonly jobs: JobService) { super(workerId); }
  private reconcile(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.jobs.reconcileExpiredLeases(new Date(), undefined, { types: [DIRECTOR_GENERATE_SCRIPT, DIRECTOR_GENERATE_STORYBOARD], recover: directorLeaseRecoveryHandler }).then(() => undefined).catch(() => { console.error(JSON.stringify({ level: 'error', event: 'director.lease_recovery_failed', code: 'LEASE_RECOVERY_FAILED' })); }).finally(() => { this.active = null; });
    return this.active;
  }
  override async start(): Promise<void> { await this.reconcile(); await super.start(); this.timer = setInterval(() => { void this.reconcile(); }, 5_000); this.timer.unref(); }
  override async shutdown(signal: string): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; if (this.active) await this.active; await super.shutdown(signal); }
}

export function createDirectorWorker(dependencies?: DirectorWorkerDependencies): WorkerRuntime {
  if (!dependencies) throw new Error('Director worker requires explicit Director worker dependencies');
  const runtime = new DirectorWorkerRuntime('director-worker', dependencies.jobs);
  runtime.register(DIRECTOR_GENERATE_SCRIPT, createDirectorJobHandler(DIRECTOR_GENERATE_SCRIPT, dependencies));
  runtime.register(DIRECTOR_GENERATE_STORYBOARD, createDirectorJobHandler(DIRECTOR_GENERATE_STORYBOARD, dependencies));
  return runtime;
}

if (basename(process.argv[1] ?? '') === 'main.ts') throw new Error('Director worker composition must be provided by the deployment entrypoint');
