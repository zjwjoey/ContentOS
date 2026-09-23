import { isPortOpen, isProcessAlive, probeRuntimeIdentity } from './port.js';
import { RuntimeStateStore } from './state.js';
import type { RuntimeStateFile } from './types.js';

export type RuntimeInstanceDisposition = 'AVAILABLE' | 'RUNNING' | 'STARTING' | 'STALE' | 'CONFLICT';
export interface RuntimeInstanceInspection { disposition: RuntimeInstanceDisposition; state: RuntimeStateFile | null; lock: Record<string, unknown> | null; identity?: { instanceId: string; hostPid: number }; }

export class InstanceGuard {
  constructor(private readonly store: RuntimeStateStore, private readonly controlPort: number) {}
  async inspect(): Promise<RuntimeInstanceInspection> {
    const state = await this.store.read(); const lock = await this.store.readLock(); const port = state?.controlPort || Number(lock?.controlPort) || this.controlPort; const open = await isPortOpen(port); const identity = open ? await probeRuntimeIdentity(port) : null;
    if (state && open && identity?.instanceId === state.instanceId && identity.hostPid === state.hostPid) return { disposition: 'RUNNING', state, lock, identity };
    // A listening control port is never treated as a stale lock or a starting
    // runtime: without a matching ContentOS identity it belongs to another
    // process and must fail closed.
    if (open) return { disposition: 'CONFLICT', state, lock, ...(identity ? { identity } : {}) };
    if (state && (state.state === 'STARTING' || state.state === 'STOPPING') && isProcessAlive(state.hostPid)) return { disposition: 'STARTING', state, lock, ...(identity ? { identity } : {}) };
    if (lock && isProcessAlive(Number(lock.hostPid))) return { disposition: 'STARTING', state, lock };
    if (state || lock) return { disposition: 'STALE', state, lock };
    return { disposition: 'AVAILABLE', state: null, lock: null };
  }
  async cleanupStale(inspection: RuntimeInstanceInspection): Promise<boolean> { return this.store.claimStale(inspection.lock, inspection.state); }
}
