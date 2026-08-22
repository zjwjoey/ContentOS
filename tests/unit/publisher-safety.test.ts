import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { publisherSmokeExitCode } from '../../scripts/publisher-smoke.js';
import { startPublisherWorkerEntrypoint } from '../../workers/publisher-worker/src/main.js';

test('publisher smoke reports a nonzero exit code unless the platform confirms publication', () => {
  assert.equal(publisherSmokeExitCode({ status: 'PUBLISHED' }), 0);
  assert.equal(publisherSmokeExitCode({ status: 'FAILED' }), 1);
  assert.equal(publisherSmokeExitCode({ status: 'UNKNOWN_EXTERNAL_STATE' }), 1);
});

test('Publisher Worker executable fails closed without an explicit real composition', async () => {
  await assert.rejects(() => startPublisherWorkerEntrypoint(), /explicit real composition/i);
});

test('Publisher browser profiles and evidence artifacts are ignored by Git', () => {
  const result = spawnSync('git', ['check-ignore', '--no-index', 'storage/publisher-profiles/account/Default/Cookies', 'artifacts/publisher/failure.png'], { cwd: process.cwd() });
  assert.equal(result.status, 0);
});
