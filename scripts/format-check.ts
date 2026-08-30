import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
async function gitOutput(args: string[], fallback: string[]): Promise<string> {
  try {
    return (await run('git', args)).stdout;
  } catch {
    return (await run('git', fallback)).stdout;
  }
}

const tracked = (await gitOutput(['diff', '--name-only', 'origin/main'], ['diff', '--name-only', 'HEAD^'])).split(/\r?\n/).filter(Boolean);
const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard'])).stdout.split(/\r?\n/).filter(Boolean);
const files = [...new Set([...tracked, ...untracked])].filter(
  (file) => /\.(ts|tsx|js|mjs|cjs|json|md|css|yaml|yml)$/.test(file) && !/^(task_plan|progress|findings)\.md$/.test(file),
);
if (files.length === 0) {
  console.log('format check passed (no changed supported files)');
  process.exit(0);
}
const prettierCli = resolve(process.cwd(), 'node_modules', 'prettier', 'bin', 'prettier.cjs');
const write = process.argv.includes('--write');
const result = await run(process.execPath, [prettierCli, write ? '--write' : '--check', ...files]);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
console.log(`${write ? 'format' : 'format check'} passed (${files.length} changed files)`);
