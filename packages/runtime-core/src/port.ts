import { createConnection } from 'node:net';
import type { RuntimeIdentity } from './types.js';

export async function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 350): Promise<boolean> {
  return new Promise((resolve) => { const socket = createConnection({ port, host }); let settled = false; const finish = (value: boolean) => { if (settled) return; settled = true; socket.destroy(); resolve(value); }; socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(timeoutMs, () => finish(false)); });
}
export async function assertPortAvailable(port: number, serviceId: string): Promise<void> { if (await isPortOpen(port)) throw Object.assign(new Error(`PORT_IN_USE:${serviceId}:${port}`), { code: 'PORT_IN_USE', serviceId, port }); }
export async function probeRuntimeIdentity(port: number, timeoutMs = 750): Promise<RuntimeIdentity | null> { try { const response = await fetch(`http://127.0.0.1:${port}/runtime/identity`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(timeoutMs) }); if (!response.ok) return null; const value = await response.json() as Partial<RuntimeIdentity>; if (value.protocol !== 'contentos-runtime' || value.protocolVersion !== 1 || typeof value.instanceId !== 'string' || typeof value.hostPid !== 'number') return null; return value as RuntimeIdentity; } catch { return null; } }
export function isProcessAlive(pid: number | undefined): boolean { if (!pid || pid <= 0 || pid === process.pid) return pid === process.pid; try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } }
