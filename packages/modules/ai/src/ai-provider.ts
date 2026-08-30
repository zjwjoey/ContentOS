import type { AIProvider, AIProviderCapability, AIRequest, AIResult, ProviderErrorCode } from '../../../contracts/src/index.js';

export type { AIProvider, AIProviderCapability, AIRequest, AIResult, ProviderErrorCode };

const retryableCodes = new Set<ProviderErrorCode>(['UNAVAILABLE', 'RATE_LIMITED']);

export class AIProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: ProviderErrorCode, message: string, retryable = retryableCodes.has(code)) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function normalizeProviderError(error: unknown): AIProviderError {
  if (error instanceof AIProviderError) return error;
  return new AIProviderError('UNKNOWN', error instanceof Error ? error.message : 'AI provider failed', false);
}
