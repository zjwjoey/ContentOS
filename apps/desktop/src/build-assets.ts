import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const source = resolve(root, 'apps/desktop/src/renderer/failure.html');
const target = resolve(root, 'dist/apps/desktop/src/renderer/failure.html');
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`Copied ${source} -> ${target}`);
