import { createDatabase, migrateUp } from '../../../packages/database/src/index.js';
import { loadConfig } from '../../../packages/config/src/index.js';
import { JobService } from '../../../packages/modules/job/src/index.js';
import { PublisherService } from '../../../packages/modules/publisher/src/index.js';
import { ReviewAnalyticsService, REVIEW_COLLECT_METRICS } from '../../../packages/modules/review/src/index.js';
import { REVIEW_GENERATE_ANALYSIS } from '../../../packages/modules/review/src/index.js';
import { FakeMetricsSource } from '../../../packages/modules/review/src/fake-metrics-source.js';
import { AIService, FakeAIProvider, PromptRegistry } from '../../../packages/modules/ai/src/index.js';
import { createReviewWorker } from './main.js';

async function startLocalWorker(): Promise<void> {
  const config = loadConfig();
  const db = await createDatabase(config.databaseUrl);
  await migrateUp(db);
  const jobs = new JobService(db);
  const publisher = new PublisherService(db);
  const analytics = new ReviewAnalyticsService(db, jobs, publisher);
  const ai = new AIService(db, new FakeAIProvider(), new PromptRegistry(), { id: 'review-fake-profile', providerId: 'fake', modelId: 'fake-zh-v1', displayName: 'Fake Chinese V1', capabilities: ['TEXT', 'STRUCTURED'], maxInputCharacters: 20_000, maxOutputTokens: 2_000, enabled: true });
  const worker = createReviewWorker({ jobs, analytics, posts: publisher, metricsSource: new FakeMetricsSource(), ai, workerId: 'review-worker-dev' });
  await worker.start();
  const poll = async () => {
    const runnable = await jobs.listRunnable([REVIEW_COLLECT_METRICS, REVIEW_GENERATE_ANALYSIS], 10);
    await Promise.all(runnable.map((job) => worker.execute(job.type, { jobId: job.id })));
  };
  const timer = setInterval(() => { void poll(); }, 250);
  timer.unref();
  await poll();
  const close = async (signal: string) => { clearInterval(timer); await worker.shutdown(signal); await db.end(); };
  process.once('SIGINT', () => { void close('SIGINT'); });
  process.once('SIGTERM', () => { void close('SIGTERM'); });
}

if (process.argv[1]?.endsWith('dev-main.ts')) await startLocalWorker();
