import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPortOpen, resolveRuntimePaths, RuntimeStateStore, runDoctor } from '../../../packages/runtime-core/src/index.js';
import { RuntimeClient } from '../../../packages/runtime-client/src/index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const rootEnv: Record<string, string | undefined> = { ...process.env, CONTENTOS_APP_ROOT: process.env.CONTENTOS_APP_ROOT || packageRoot, DATABASE_URL: process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_operator_dev', STORAGE_ROOT: process.env.STORAGE_ROOT || resolve(process.env.CONTENTOS_APP_ROOT || packageRoot, 'storage', 'local') };
const client = new RuntimeClient({ env: rootEnv });
const store = new RuntimeStateStore(resolveRuntimePaths(rootEnv));
const command = process.argv[2] || 'status';
const print = (value: unknown) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
async function waitForHost(timeoutMs = 20_000): Promise<void> { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const state = await store.read(); if (state && await isPortOpen(state.controlPort)) return; await new Promise((resolveWait) => setTimeout(resolveWait, 250)); } throw new Error('Runtime Host 启动超时，请执行 pnpm contentos logs 查看日志。'); }
async function main(): Promise<void> {
  if (command === 'up') { const existing = await store.read(); if (existing && await isPortOpen(existing.controlPort)) { print('ContentOS already running'); print(await client.getStatus()); return; } await RuntimeClient.spawnHost({ safeMode: process.argv.includes('--safe'), foreground: process.argv.includes('--foreground'), env: rootEnv }); if (process.argv.includes('--foreground')) return; await waitForHost(); print(await client.getStatus()); return; }
  if (command === 'down') { try { print(await client.stop()); } catch (error) { if ((error as { code?: string }).code === 'RUNTIME_NOT_RUNNING') print('ContentOS is not running'); else throw error; } return; }
  if (command === 'restart') { try { print(await client.restart()); } catch (error) { if ((error as { code?: string }).code === 'RUNTIME_NOT_RUNNING') { await RuntimeClient.spawnHost({ env: rootEnv }); await waitForHost(); print(await client.getStatus()); } else throw error; } return; }
  if (command === 'status') { try { print(await client.getStatus()); } catch (error) { if ((error as { code?: string }).code === 'RUNTIME_NOT_RUNNING') print({ state: 'STOPPED', services: [] }); else throw error; } return; }
  if (command === 'services') { print(await client.getServices()); return; }
  if (command === 'doctor') { const state = await store.read(); if (state && await isPortOpen(state.controlPort)) print(await client.runDoctor()); else print(await runDoctor(resolveRuntimePaths(rootEnv), rootEnv)); return; }
  if (command === 'logs') { print(await client.getLogs({ ...(process.argv[3] ? { serviceId: process.argv[3] } : {}), limit: 200 })); return; }
  if (command === 'restart-service') { if (!process.argv[3]) throw new Error('serviceId required'); print(await client.restartService(process.argv[3])); return; }
  throw new Error(`Unknown ContentOS command: ${command}`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
