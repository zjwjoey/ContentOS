export type ErrorCategory = 'DomainError' | 'ValidationError' | 'InfrastructureError' | 'ExternalProcessError' | 'RetryableError' | 'NonRetryableError';

export interface ErrorEnvelope {
  code: string;
  message: string;
  correlationId: string;
  details: unknown[];
}

export function serializeError(error: unknown, category: ErrorCategory, correlationId: string): ErrorEnvelope {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return { code: category.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(), message, correlationId, details: [] };
}
