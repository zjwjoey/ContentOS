import type { DoctorReport, RuntimeLog, RuntimeStatus, ServiceStatus } from '../../runtime-core/src/index.js';

export const DESKTOP_API_VERSION = 1 as const;
export type DesktopRuntimePhase = 'STOPPED' | 'STARTING' | 'READY' | 'READY_WITH_WARNINGS' | 'DEGRADED' | 'FAILED' | 'STOPPING';
export interface DesktopRuntimeError { code: string; message: string; at: string; details?: Record<string, unknown>; }
export interface DesktopRuntimeSnapshot { apiVersion: 1; phase: DesktopRuntimePhase; status: RuntimeStatus | null; error: DesktopRuntimeError | null; logRoot: string; }
export interface DesktopRuntimeResult { ok: boolean; snapshot: DesktopRuntimeSnapshot; doctor?: DoctorReport; services?: ServiceStatus[]; logs?: RuntimeLog[]; }
export interface DesktopApi {
  getSnapshot(): Promise<DesktopRuntimeSnapshot>;
  start(options?: { safeMode?: boolean }): Promise<DesktopRuntimeResult>;
  stop(): Promise<DesktopRuntimeResult>;
  restart(options?: { safeMode?: boolean }): Promise<DesktopRuntimeResult>;
  restartService(serviceId: string): Promise<DesktopRuntimeResult>;
  doctor(): Promise<DesktopRuntimeResult>;
  logs(query?: { serviceId?: string; limit?: number }): Promise<DesktopRuntimeResult>;
  onStatus(listener: (snapshot: DesktopRuntimeSnapshot) => void): () => void;
}
