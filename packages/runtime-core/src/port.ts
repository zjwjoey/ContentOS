import { createConnection } from 'node:net';

export async function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 350): Promise<boolean> {
  return new Promise((resolve) => { const socket = createConnection({ port, host }); let settled = false; const finish = (value: boolean) => { if (settled) return; settled = true; socket.destroy(); resolve(value); }; socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(timeoutMs, () => finish(false)); });
}
export async function assertPortAvailable(port: number, serviceId: string): Promise<void> { if (await isPortOpen(port)) throw Object.assign(new Error(`PORT_IN_USE:${serviceId}:${port}`), { code: 'PORT_IN_USE', serviceId, port }); }
