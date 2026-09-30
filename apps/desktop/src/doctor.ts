import { access, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../..');
const required = ['dist/apps/desktop/src/main/main.js', 'dist/apps/desktop/src/main/preload.js', 'apps/desktop/src/renderer/failure.html', 'dist/apps/runtime-host/src/main.js', 'migrations'];
const failures: string[] = [];
for (const item of required) { try { await stat(resolve(root, item)); } catch { failures.push(`${item}: missing`); } }
try { await access(resolve(root, 'apps/web/.next')); } catch { failures.push('apps/web/.next: missing; packaged Web requires a production Next build'); }
const report = { ok: failures.length === 0, root, required, failures };
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
