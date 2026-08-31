import { createDatabase, migrateUp } from '../../../packages/database/src/index.js';
import { loadConfig } from '../../../packages/config/src/index.js';
import { AIService, PromptRegistry, createRuntimeAI } from '../../../packages/modules/ai/src/index.js';
import { BenchmarkService, BENCHMARK_ANALYZE } from '../../../packages/modules/benchmark/src/index.js';
import { JobService } from '../../../packages/modules/job/src/index.js';
import { JobRunner } from '../../../packages/modules/job/src/index.js';
import { createBenchmarkJobHandler } from './handler.js';

const runTypes = [BENCHMARK_ANALYZE];

async function start(): Promise<void> {
  const config = loadConfig(); const db = await createDatabase(config.databaseUrl); await migrateUp(db);
  const jobs = new JobService(db); const benchmark = new BenchmarkService(db, jobs); const aiRuntime = createRuntimeAI(); const ai = new AIService(db, aiRuntime.provider, new PromptRegistry(), aiRuntime.profile); const handler = createBenchmarkJobHandler({ jobs, benchmark, ai }); let stopped = false;
  const poll = async () => { if (stopped) return; for (const job of await jobs.listRunnable(runTypes, 10)) { await new JobRunner(jobs, 'benchmark-worker').run(job.id, (record, attemptId, signal) => handler(record, attemptId, signal)); } };
  const timer = setInterval(() => { void poll(); }, 250); await poll();
  const close = async () => { if (stopped) return; stopped = true; clearInterval(timer); await db.end(); process.exit(0); };
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
}
if (process.argv[1]?.endsWith('dev-main.ts')) await start();
