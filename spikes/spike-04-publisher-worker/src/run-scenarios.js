const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FakePlatform, PublisherWorker, PublisherJobStore, RedactingLogger } = require('./publisher-worker');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'contentos-spike04-run-'));
  const logger = new RedactingLogger();
  const platform = new FakePlatform({ profiles: { alpha: { token: 'token-alpha', requiresVerification: false, cookies: { session: 'a' } } } });
  const store = new PublisherJobStore(path.join(root, 'jobs.json'));
  await store.load();
  const worker = new PublisherWorker({ platform, profileRoot: path.join(root, 'profiles'), logger, jobStore: store });
  const success = await worker.publish({ jobId: 'run-success', profileId: 'alpha', token: 'token-alpha', content: { title: 'Fake publish' } });
  const auth = await worker.publish({ jobId: 'run-auth', profileId: 'alpha', token: 'wrong', content: { title: 'Fake publish' } });
  const browser = await worker.publish({ jobId: 'run-browser', profileId: 'alpha', token: 'token-alpha', content: { title: 'Fake publish' }, crashAt: 1 });
  const result = { spike: 'SPIKE_04_PUBLISHER_WORKER', success: success.status, auth: auth.error.code, browser: browser.error.code, publishedCount: platform.published.length, logContainsToken: JSON.stringify(logger.events).includes('token-alpha') };
  const evidenceDir = path.resolve(__dirname, '..', '..', 'evidence');
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, 'SPIKE_04_RUN_SUMMARY.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
  await fs.rm(root, { recursive: true, force: true });
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
