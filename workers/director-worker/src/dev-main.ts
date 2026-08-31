import { createDatabase, migrateUp } from '../../../packages/database/src/index.js';
import { loadConfig } from '../../../packages/config/src/index.js';
import { AIService, PromptRegistry, createRuntimeAI } from '../../../packages/modules/ai/src/index.js';
import { DIRECTOR_GENERATE_SCRIPT, DIRECTOR_GENERATE_STORYBOARD } from '../../../packages/modules/director/src/director-job-service.js';
import { DirectorV1Service } from '../../../packages/modules/director/src/director-v1-service.js';
import { JobService } from '../../../packages/modules/job/src/index.js';
import { createDirectorWorker, type DirectorWorkerDependencies } from './main.js';
import { BenchmarkService } from '../../../packages/modules/benchmark/src/index.js';

const directorJobTypes = [DIRECTOR_GENERATE_SCRIPT, DIRECTOR_GENERATE_STORYBOARD];

export interface DirectorDevRunnerOptions { pollIntervalMs?: number; batchSize?: number; }
export interface DirectorDevRunner {
  start(): Promise<void>;
  stop(signal?: string): Promise<void>;
  pollOnce(): Promise<void>;
}

export function createDirectorDevRunner(dependencies: DirectorWorkerDependencies, options: DirectorDevRunnerOptions = {}): DirectorDevRunner {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const batchSize = options.batchSize ?? 10;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('Director poll interval must be a positive integer');
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('Director batch size must be a positive integer');
  const runtime = createDirectorWorker(dependencies);
  let timer: NodeJS.Timeout | undefined;
  let started = false;
  let polling = false;

  const pollOnce = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const jobs = await dependencies.jobs.listRunnable(directorJobTypes, batchSize);
      for (const job of jobs) await runtime.execute(job.type, { jobId: job.id });
    } finally { polling = false; }
  };

  return {
    pollOnce,
    async start() {
      if (started) return;
      await runtime.start();
      started = true;
      await pollOnce();
      timer = setInterval(() => { void pollOnce(); }, pollIntervalMs);
    },
    async stop(signal = 'SIGTERM') {
      if (timer) { clearInterval(timer); timer = undefined; }
      if (!started) return;
      await runtime.shutdown(signal);
      started = false;
    },
  };
}

async function startLocalWorker(): Promise<void> {
  const config = loadConfig();
  const db = await createDatabase(config.databaseUrl);
  await migrateUp(db);
  const jobs = new JobService(db);
  const benchmark = new BenchmarkService(db, jobs);
  const aiRuntime = createRuntimeAI();
  const dependencies: DirectorWorkerDependencies = {
    jobs,
    director: new DirectorV1Service(db),
    ai: new AIService(db, aiRuntime.provider, new PromptRegistry(), aiRuntime.profile),
    modelProfile: aiRuntime.profile,
    benchmark,
  };
  const runner = createDirectorDevRunner(dependencies);
  await runner.start();
  const close = async (signal: string) => { await runner.stop(signal); await db.end(); };
  process.once('SIGINT', () => { void close('SIGINT'); });
  process.once('SIGTERM', () => { void close('SIGTERM'); });
}

if (process.argv[1]?.endsWith('dev-main.ts')) await startLocalWorker();
