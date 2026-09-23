import { resolveRuntimeConfig, runtimeConfigEnv, RuntimeStateStore, runDoctor } from '../../../packages/runtime-core/src/index.js';
import { RuntimeClient } from '../../../packages/runtime-client/src/index.js';

const config = resolveRuntimeConfig(process.env);
const rootEnv: Record<string, string | undefined> = runtimeConfigEnv(config, process.env);
const client = new RuntimeClient({ env: rootEnv });
const store = new RuntimeStateStore(config);
const command = process.argv[2] || 'status';
const print = (value: unknown) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

async function main(): Promise<void> {
  if (command === 'up') { if (process.argv.includes('--foreground')) { await RuntimeClient.spawnHost({ safeMode: process.argv.includes('--safe'), foreground: true, env: rootEnv }); return; } print(await client.start({ safeMode: process.argv.includes('--safe') })); return; }
  if (command === 'down') { try { print(await client.stop()); } catch (error) { if ((error as { code?: string }).code === 'RUNTIME_NOT_RUNNING') print('ContentOS is not running'); else throw error; } return; }
  if (command === 'restart') { print(await client.restart({ safeMode: process.argv.includes('--safe') })); return; }
  if (command === 'status') { try { print(await client.getStatus()); } catch (error) { if ((error as { code?: string }).code === 'RUNTIME_NOT_RUNNING') print({ state: 'STOPPED', services: [] }); else throw error; } return; }
  if (command === 'services') { print(await client.getServices()); return; }
  if (command === 'doctor') { const state = await store.read(); if (state) { try { print(await client.runDoctor()); return; } catch (error) { if ((error as { code?: string }).code !== 'RUNTIME_CONTROL_PORT_CONFLICT') throw error; } } print(await runDoctor(config, rootEnv)); return; }
  if (command === 'logs') { print(await client.getLogs({ ...(process.argv[3] ? { serviceId: process.argv[3] } : {}), limit: 200 })); return; }
  if (command === 'restart-service') { if (!process.argv[3]) throw new Error('serviceId required'); print(await client.restartService(process.argv[3])); return; }
  throw new Error(`Unknown ContentOS command: ${command}`);
}
main().catch((error) => { const value = error as { code?: string; details?: unknown; runtimeState?: unknown; services?: unknown; logPath?: string }; console.error(JSON.stringify({ code: value.code || 'RUNTIME_ERROR', message: error instanceof Error ? error.message : String(error), ...(value.details ? { details: value.details } : {}), ...(value.runtimeState ? { runtimeState: value.runtimeState } : {}), ...(value.services ? { services: value.services } : {}), ...(value.logPath ? { logPath: value.logPath } : {}) }, null, 2)); process.exitCode = 1; });
