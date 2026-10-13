import { redact, redactText } from './redaction.js';

export interface Logger {
  info(event: string, context?: Record<string, unknown>): void;
  warn(event: string, context?: Record<string, unknown>): void;
  error(event: string, context?: Record<string, unknown>): void;
}

export function createLogger(sink: (line: string) => void = (line) => console.log(line)): Logger {
  const write = (level: string, event: string, context: Record<string, unknown> = {}) => {
    sink(JSON.stringify({ timestamp: new Date().toISOString(), level, event: redactText(event), ...redact(context) as Record<string, unknown> }));
  };
  return { info: (event, context) => write('info', event, context), warn: (event, context) => write('warn', event, context), error: (event, context) => write('error', event, context) };
}
