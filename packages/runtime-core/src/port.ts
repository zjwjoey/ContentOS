import { createConnection } from 'node:net';
import type { RuntimeIdentity } from './types.js';

export async function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 350): Promise<boolean> {
  return new Promise((resolve) => { const socket = createConnection({ port, host }); let settled = false; const finish = (value: boolean) => { if (settled) return; settled = true; socket.destroy(); resolve(value); }; socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(timeoutMs, () => finish(false)); });
}
export async function assertPortAvailable(port: number, serviceId: string): Promise<void> { if (await isPortOpen(port)) throw Object.assign(new Error(`PORT_IN_USE:${serviceId}:${port}`), { code: 'PORT_IN_USE', serviceId, port }); }
export interface RuntimePortAllocation { api: number; web: number; control: number; database: number; }
export async function findAvailablePort(start: number, end: number, reserved: Set<number> = new Set()): Promise<number> {
  for (let port = start; port <= end; port += 1) {
    if (reserved.has(port)) continue;
    if (!(await isPortOpen(port))) { reserved.add(port); return port; }
  }
  throw Object.assign(new Error(`No available port in range ${start}-${end}`), { code: 'PORT_RANGE_EXHAUSTED', start, end });
}
export async function allocateRuntimePorts(env: Record<string, string | undefined> = process.env): Promise<RuntimePortAllocation> {
  const start = Number(env.CONTENTOS_PORT_RANGE_START || 3000);
  const end = Number(env.CONTENTOS_PORT_RANGE_END || 3999);
  const dbStart = Number(env.CONTENTOS_DATABASE_PORT_RANGE_START || 55433);
  const dbEnd = Number(env.CONTENTOS_DATABASE_PORT_RANGE_END || 55599);
  const reserved = new Set<number>();
  const api = env.PORT ? Number(env.PORT) : await findAvailablePort(start, end, reserved);
  reserved.add(api);
  const web = env.WEB_PORT ? Number(env.WEB_PORT) : await findAvailablePort(start, end, reserved);
  reserved.add(web);
  const control = env.CONTENTOS_RUNTIME_CONTROL_PORT ? Number(env.CONTENTOS_RUNTIME_CONTROL_PORT) : await findAvailablePort(start, end, reserved);
  const database = env.CONTENTOS_DATABASE_PORT ? Number(env.CONTENTOS_DATABASE_PORT) : await findAvailablePort(dbStart, dbEnd);
  return { api, web, control, database };
}
export async function probeRuntimeIdentity(port: number, timeoutMs = 750): Promise<RuntimeIdentity | null> { try { const response = await fetch(`http://127.0.0.1:${port}/runtime/identity`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(timeoutMs) }); if (!response.ok) return null; const value = await response.json() as Partial<RuntimeIdentity>; if (value.protocol !== 'contentos-runtime' || value.protocolVersion !== 1 || typeof value.instanceId !== 'string' || typeof value.hostPid !== 'number') return null; return value as RuntimeIdentity; } catch { return null; } }
export function isProcessAlive(pid: number | undefined): boolean { if (!pid || pid <= 0 || pid === process.pid) return pid === process.pid; try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } }
