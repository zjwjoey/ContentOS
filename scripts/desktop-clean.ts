import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
for (const path of [resolve(root, 'dist'), resolve(root, 'apps/web/.next'), resolve(root, 'artifacts/desktop')]) {
  await rm(path, { recursive: true, force: true });
  console.log(`Cleaned ${path}`);
}
