export function qwenEndpoint(value: string, path: '/chat/completions' | '/embeddings'): string {
  const base = value.trim().replace(/\/+$/u, '');
  if (base.endsWith(path)) return base;
  if (base.endsWith('/chat/completions') || base.endsWith('/embeddings')) return `${base.slice(0, base.lastIndexOf('/'))}${path}`;
  return `${base}${path}`;
}
