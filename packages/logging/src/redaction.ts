const sensitiveKey = /(password|token|cookie|authorization|secret|api[-_]?key|session)/iu;

export function redactText(text: string): string {
  return text
    .replace(/:\/\/([^:/\s]+):([^@\s]+)@/gu, '://$1:[REDACTED]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:set-cookie|cookie|authorization)\s*:\s*[^\r\n]+/giu, '[REDACTED HEADER]')
    .replace(/(["']?(?:password|access[-_]?token|refresh[-_]?token|token|cookie|secret|api[-_]?key|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/giu, '$1[REDACTED]');
}

export function redact(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value);
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => redact(item, '', seen));
      const fields = value instanceof Error ? { name: value.name, message: value.message, ...Object.fromEntries(Object.entries(value)) } : value;
      return Object.fromEntries(Object.entries(fields).map(([childKey, childValue]) => [childKey, redact(childValue, childKey, seen)]));
    } finally { seen.delete(value); }
  }
  return value;
}
