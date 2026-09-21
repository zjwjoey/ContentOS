import assert from 'node:assert/strict';
import type { AvatarGenerationRequest, AvatarProvider, AvatarTaskStatus } from '../../packages/contracts/src/index.js';
import { DigitalHumanProviderError } from '../../packages/modules/digital-human/src/index.js';

const statuses = new Set<AvatarTaskStatus['status']>(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
const providerErrorCodes = new Set(['UNAVAILABLE', 'RATE_LIMITED', 'AUTHENTICATION_FAILED', 'INVALID_REQUEST', 'EXTERNAL_FAILED']);

export interface AvatarProviderContractErrorCase { name: string; run: () => Promise<unknown>; code: 'UNAVAILABLE' | 'RATE_LIMITED' | 'AUTHENTICATION_FAILED' | 'INVALID_REQUEST' | 'EXTERNAL_FAILED'; retryable: boolean; }
export type AvatarProviderContractMode = 'FAKE' | 'REAL';
export interface AvatarProviderContractOptions { mode: AvatarProviderContractMode; createProvider: () => AvatarProvider | Promise<AvatarProvider>; errorCases?: AvatarProviderContractErrorCase[]; }

function assertProviderIdentity(providerId: string, value: string, label: string): void { assert.equal(typeof value, 'string', `${label} must be a string`); assert.ok(value.trim(), `${label} must be non-empty`); assert.equal(value, providerId, `${label} must match provider.providerId`); }

export async function runAvatarProviderContractTests(options: AvatarProviderContractOptions): Promise<void> {
  if (options.mode === 'REAL') {
    const required = new Set(providerErrorCodes);
    const supplied = new Set((options.errorCases || []).map((errorCase) => errorCase.code));
    assert.deepEqual([...supplied].sort(), [...required].sort(), 'REAL AvatarProvider contract tests must cover every normalized provider error code');
  }
  const provider = await options.createProvider();
  assertProviderIdentity(provider.providerId, provider.providerId, 'provider.providerId');
  const capabilities = await provider.getCapabilities();
  assertProviderIdentity(provider.providerId, capabilities.providerId, 'capabilities.providerId');
  assert.equal(typeof capabilities.videoToVideo, 'boolean');
  assert.equal(typeof capabilities.imageToVideo, 'boolean');
  assert.equal(typeof capabilities.requiresPublicUrl, 'boolean');
  assert.ok(Array.isArray(capabilities.supportedFormats) && capabilities.supportedFormats.length > 0);
  assert.ok(capabilities.supportedFormats.every((format) => typeof format === 'string' && format.trim() === format && format.length > 0));
  if (capabilities.supportedAudioFormats) assert.ok(capabilities.supportedAudioFormats.every((format) => typeof format === 'string' && format.trim() === format && format.length > 0));
  if (capabilities.maxDurationSeconds !== undefined) assert.ok(Number.isFinite(capabilities.maxDurationSeconds) && capabilities.maxDurationSeconds > 0);

  const request: AvatarGenerationRequest = { requestId: `contract-request-${Date.now()}`, projectId: 'contract-project', jobId: 'contract-job', attemptId: 'contract-attempt', correlationId: 'contract-correlation', audioUrl: 'https://media.example/audio.wav', videoUrl: 'https://media.example/video.mp4', model: 'opaque-test-model', parameters: { contract: true } };
  const submitted = await provider.submitLipSync(request);
  assert.ok(submitted.externalTaskId.trim());
  assertProviderIdentity(provider.providerId, submitted.providerId, 'submit result providerId');
  assert.ok(statuses.has(submitted.status));
  if (submitted.status === 'SUCCEEDED') assert.ok(submitted.outputUrl, 'successful submit must include outputUrl');
  const duplicate = await provider.submitLipSync(request);
  assert.equal(duplicate.externalTaskId, submitted.externalTaskId, 'requestId must be the provider idempotency boundary');

  const task = await provider.getTask(submitted.externalTaskId);
  assert.equal(task.externalTaskId, submitted.externalTaskId);
  assertProviderIdentity(provider.providerId, task.providerId, 'task result providerId');
  assert.ok(statuses.has(task.status));
  if (task.status === 'SUCCEEDED') assert.ok(task.outputUrl, 'successful task must include outputUrl');
  if (task.status === 'FAILED') assert.ok(task.errorCode || task.errorMessage, 'failed task must include normalized error details');
  if (task.provenance?.provider !== undefined) assert.equal(task.provenance.provider, provider.providerId);
  for (const [name, value] of [['costAmount', task.costAmount], ['billingQuantity', task.billingQuantity]] as const) if (value !== undefined) assert.ok(Number.isFinite(value) && value >= 0, `${name} must be a finite non-negative number`);

  if (provider.cancelTask) {
    await provider.cancelTask(submitted.externalTaskId);
    await provider.cancelTask(submitted.externalTaskId);
    const afterCancel = await provider.getTask(submitted.externalTaskId);
    assertProviderIdentity(provider.providerId, afterCancel.providerId, 'cancelled task providerId');
    assert.ok(statuses.has(afterCancel.status));
    if (task.status === 'SUCCEEDED' || task.status === 'FAILED' || task.status === 'CANCELLED') assert.equal(afterCancel.status, task.status, 'cancelling a terminal task must be stable');
    else assert.equal(afterCancel.status, 'CANCELLED');
  }

  for (const errorCase of options.errorCases || []) {
    await assert.rejects(errorCase.run, (error: unknown) => error instanceof DigitalHumanProviderError && providerErrorCodes.has(error.code) && error.code === errorCase.code && error.retryable === errorCase.retryable, `${errorCase.name} must be normalized as DigitalHumanProviderError`);
  }
}

export function assertNormalizedAvatarProviderError(error: unknown, code: AvatarProviderContractErrorCase['code'], retryable: boolean): asserts error is DigitalHumanProviderError { assert.ok(error instanceof DigitalHumanProviderError); assert.equal(error.code, code); assert.equal(error.retryable, retryable); }
