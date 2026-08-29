import { spawn } from 'node:child_process';

const child = spawn('pnpm', ['tsx', '--test', '--test-concurrency=1', 'tests/e2e/operator-browser.test.ts'], { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
