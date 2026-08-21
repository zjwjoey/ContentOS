const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FakePlatform, PublisherWorker, PublisherJobStore, RedactingLogger } = require('../src/publisher-worker');

let root;
let profiles;
let platform;
let logger;
let worker;

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'contentos-spike04-'));
  profiles = { alpha: { token: 'token-alpha', requiresVerification: false, cookies: { session: 'a' } }, beta: { token: 'token-beta', requiresVerification: false, cookies: { session: 'b' } } };
  platform = new FakePlatform({ profiles });
  logger = new RedactingLogger();
  worker = new PublisherWorker({ platform, profileRoot: path.join(root, 'profiles'), logger });
});

test.afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('fake-platform publish succeeds without external access', async () => {
  const result = await worker.publish({ jobId: 'job-success', profileId: 'alpha', token: 'token-alpha', content: { title: 'hello' } });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(platform.published.length, 1);
  assert.equal(platform.published[0].profileId, 'alpha');
});

test('auth and verification failures are structured and non-successful', async () => {
  const auth = await worker.publish({ jobId: 'job-auth', profileId: 'alpha', token: 'wrong', content: { title: 'x' } });
  assert.equal(auth.error.code, 'AUTH_REQUIRED');
  platform.profiles.alpha.requiresVerification = true;
  const verification = await worker.publish({ jobId: 'job-verify', profileId: 'alpha', token: 'token-alpha', content: { title: 'x' } });
  assert.equal(verification.error.code, 'VERIFICATION_REQUIRED');
  assert.equal(platform.published.length, 0);
});

test('DOM change is detected before a publish side effect', async () => {
  platform.domVersion = 'v2';
  const result = await worker.publish({ jobId: 'job-dom', profileId: 'alpha', token: 'token-alpha', content: { title: 'x' } });
  assert.equal(result.error.code, 'DOM_CHANGED');
  assert.equal(platform.published.length, 0);
});

test('browser crash is isolated and never reports success', async () => {
  const result = await worker.publish({ jobId: 'job-browser', profileId: 'alpha', token: 'token-alpha', content: { title: 'x' }, crashAt: 1 });
  assert.equal(result.error.code, 'BROWSER_CRASH');
  assert.equal(platform.published.length, 0);
});

test('worker crash leaves durable RUNNING state and retry can complete once', async () => {
  const store = new PublisherJobStore(path.join(root, 'jobs.json'));
  await store.load();
  const crashWorker = new PublisherWorker({ platform, profileRoot: path.join(root, 'profiles'), logger, jobStore: store });
  const crashed = await crashWorker.publish({ jobId: 'job-worker-crash', profileId: 'alpha', token: 'token-alpha', content: { title: 'x' }, simulateWorkerCrash: true });
  assert.equal(crashed.status, 'WORKER_CRASHED');
  assert.equal(store.get('job-worker-crash').status, 'RUNNING');
  const retry = await crashWorker.publish({ jobId: 'job-worker-crash', profileId: 'alpha', token: 'token-alpha', content: { title: 'x' } });
  assert.equal(retry.status, 'SUCCEEDED');
  assert.equal(store.get('job-worker-crash').status, 'SUCCEEDED');
  assert.equal(platform.published.length, 1);
});

test('profiles use isolated browser contexts and logs redact secrets', async () => {
  await worker.publish({ jobId: 'job-a', profileId: 'alpha', token: 'token-alpha', content: { title: 'A' } });
  await worker.publish({ jobId: 'job-b', profileId: 'beta', token: 'token-beta', content: { title: 'B' } });
  assert.notEqual(platform.profiles.alpha.cookies.session, platform.profiles.beta.cookies.session);
  assert.ok(await fs.stat(path.join(root, 'profiles', 'alpha')));
  assert.ok(await fs.stat(path.join(root, 'profiles', 'beta')));
  const logText = JSON.stringify(logger.events);
  assert.doesNotMatch(logText, /token-alpha|token-beta/);
  assert.match(logText, /REDACTED/);
});
