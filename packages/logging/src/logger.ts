const sensitiveKey = /(password|token|cookie|authorization|secret|api[-_]?key|session)/i;

function redact(value: unknown, key = ''): unknown {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  }
  if (typeof value === 'string') return value.replace(/:\/\/([^:/]+):([^@]+)@/g, '://$1:[REDACTED]@');
  return value;
}

export interface Logger {
  info(event: string, context?: Record<string, unknown>): void;
  warn(event: string, context?: Record<string, unknown>): void;
  error(event: string, context?: Record<string, unknown>): void;
}

export function createLogger(sink: (line: string) => void = (line) => console.log(line)): Logger {
  const write = (level: string, event: string, context: Record<string, unknown> = {}) => {
    sink(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...redact(context) as Record<string, unknown> }));
  };
  return { info: (event, context) => write('info', event, context), warn: (event, context) => write('warn', event, context), error: (event, context) => write('error', event, context) };
}
