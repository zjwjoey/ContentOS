import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = join(directory, entry.name);
    if (entry.isDirectory() && !['node_modules', 'dist', '.next', '.git', 'storage', 'artifacts'].includes(entry.name)) files.push(...(await walk(target)));
    else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) files.push(target);
  }
  return files;
}

const forbidden = /(?:password|token|cookie|authorization)\s*[:=]\s*['"]/i;
const roots = ['apps', 'workers', 'packages', 'scripts'];
const files = (await Promise.all(roots.map((root) => walk(join(process.cwd(), root))))).flat();
const violations: string[] = [];
for (const file of files) {
  const content = await readFile(file, 'utf8');
  if (forbidden.test(content) && !file.endsWith('doctor.ts')) violations.push(`${file}: possible secret literal`);
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log(`lint check passed (${files.length} TypeScript files)`);
