import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (/\.(ts|js|json|md)$/.test(entry.name)) files.push(target);
  }
  return files;
}

const roots = ['apps', 'workers', 'packages', 'scripts', 'tests'];
const files = (await Promise.all(roots.filter((root) => true).map((root) => walk(join(process.cwd(), root))))).flat();
const violations: string[] = [];
for (const file of files) {
  const content = await readFile(file, 'utf8');
  const normalized = content.replace(/\r\n/g, '\n');
  if (normalized.endsWith(' ')) violations.push(`${file}: trailing whitespace`);
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log(`format check passed (${files.length} files)`);
