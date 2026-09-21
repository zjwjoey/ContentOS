import test from 'node:test';
import assert from 'node:assert/strict';
import { DigitalHumanProviderError, FakeAvatarProvider } from '../../packages/modules/digital-human/src/index.js';
import { assertNormalizedAvatarProviderError, runAvatarProviderContractTests } from '../contracts/avatar-provider-contract.js';

test('FakeAvatarProvider passes the provider-neutral AvatarProvider Contract Test Kit', async () => {
  await runAvatarProviderContractTests({ mode: 'FAKE', createProvider: () => new FakeAvatarProvider('https://fixtures.example/avatar.mp4') });
});

test('REAL AvatarProvider contract mode requires the complete normalized error vocabulary', async () => {
  await assert.rejects(runAvatarProviderContractTests({ mode: 'REAL', createProvider: () => new FakeAvatarProvider('https://fixtures.example/avatar.mp4') }), /must cover every normalized provider error code/);
  const errorCases = (['UNAVAILABLE', 'RATE_LIMITED', 'AUTHENTICATION_FAILED', 'INVALID_REQUEST', 'EXTERNAL_FAILED'] as const).map((code) => ({ name: code, code, retryable: ['UNAVAILABLE', 'RATE_LIMITED'].includes(code), run: async () => { throw new DigitalHumanProviderError(code, code, ['UNAVAILABLE', 'RATE_LIMITED'].includes(code)); } }));
  await runAvatarProviderContractTests({ mode: 'REAL', createProvider: () => new FakeAvatarProvider('https://fixtures.example/avatar.mp4'), errorCases });
});

test('AvatarProvider Contract Test Kit exposes the normalized provider error vocabulary', () => {
  const cases = [
    ['UNAVAILABLE', true], ['RATE_LIMITED', true], ['AUTHENTICATION_FAILED', false], ['INVALID_REQUEST', false], ['EXTERNAL_FAILED', false],
  ] as const;
  for (const [code, retryable] of cases) assert.doesNotThrow(() => assertNormalizedAvatarProviderError(new DigitalHumanProviderError(code, code, retryable), code, retryable));
});
