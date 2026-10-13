import { createDatabase, migrateUp } from '../../../packages/database/src/index.js';
import { loadConfig } from '../../../packages/config/src/index.js';
import { AIService, PromptRegistry, createRuntimeAI } from '../../../packages/modules/ai/src/index.js';
import { BenchmarkService, BENCHMARK_ANALYZE } from '../../../packages/modules/benchmark/src/index.js';
import { JobService } from '../../../packages/modules/job/src/index.js';
import { createBenchmarkWorker } from './main.js';

const runTypes = [BENCHMARK_ANALYZE];

async function start(): Promise<void> {
  const config = loadConfig(); const db = await createDatabase(config.databaseUrl); if (process.env.CONTENTOS_SKIP_MIGRATIONS !== '1') await migrateUp(db);
  const jobs = new JobService(db); const benchmark = new BenchmarkService(db, jobs); const aiRuntime = createRuntimeAI(); const ai = new AIService(db, aiRuntime.provider, new PromptRegistry(), aiRuntime.profile); const worker = createBenchmarkWorker({ jobs, benchmark, ai }); await worker.start(); let stopped = false;
  const poll = async () => { if (stopped) return; for (const job of await jobs.listRunnable(runTypes, 10)) { await worker.execute(job.type, { jobId: job.id }); } };
  const timer = setInterval(() => { void poll(); }, 250); await poll(); console.log(JSON.stringify({ status: 'READY', workerId: 'benchmark-worker' }));
  const close = async () => { if (stopped) return; stopped = true; clearInterval(timer); await worker.shutdown('SIGTERM'); await db.end(); process.exit(0); };
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
}
if (process.argv[1]?.endsWith('dev-main.ts') || process.argv[1]?.endsWith('dev-main.js')) await start();
