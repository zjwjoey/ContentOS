export type ServiceState = 'STOPPED' | 'STARTING' | 'READY' | 'DEGRADED' | 'FAILED' | 'STOPPING';
export type RuntimeState = 'STARTING' | 'READY' | 'READY_WITH_WARNINGS' | 'DEGRADED' | 'FAILED' | 'STOPPING' | 'STOPPED';
export type ServiceKind = 'PROCESS' | 'EXTERNAL' | 'TASK';
export type RestartClass = 'TRANSIENT' | 'PERMANENT';

export interface HealthResult { state: Extract<ServiceState, 'READY' | 'DEGRADED' | 'FAILED'>; message?: string; capability?: Record<string, unknown>; }
export interface RestartPolicy { enabled: boolean; maxRestarts: number; windowMs: number; backoffMs: number[]; }
export interface ServiceDefinition {
  id: string;
  label: string;
  required: boolean;
  kind: ServiceKind;
  dependsOn: string[];
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  restartPolicy: RestartPolicy;
  restartClass?: RestartClass;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  port?: number;
  healthCheck?: () => Promise<HealthResult>;
  capabilityProbe?: () => Promise<Record<string, unknown>>;
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
}
export interface ServiceStatus {
  id: string;
  label: string;
  required: boolean;
  kind: ServiceKind;
  state: ServiceState;
  pid?: number;
  port?: number;
  dependsOn: string[];
  capability?: Record<string, unknown>;
  restartCount: number;
  lastError?: { code: string; message: string; at: string };
  startedAt?: string;
  updatedAt: string;
}
export interface RuntimeStatus { instanceId: string; hostPid: number; state: RuntimeState; startedAt: string; uptimeMs: number; controlPort: number; services: ServiceStatus[]; warnings: string[]; }
export interface DoctorCheck { id: string; scope: 'CORE' | 'OPTIONAL'; status: 'PASS' | 'WARN' | 'FAIL'; message: string; details?: Record<string, unknown>; }
export interface DoctorReport { generatedAt: string; checks: DoctorCheck[]; coreStartup: 'READY' | 'NOT_READY'; }
export interface RuntimeLog { timestamp: string; serviceId: string; level: 'INFO' | 'WARN' | 'ERROR'; event: string; message: string; }
export interface RuntimeStateFile { instanceId: string; hostPid: number; startedAt: string; controlPort: number; controlToken: string; state: RuntimeState; services: ServiceStatus[]; warnings: string[]; }
export interface RuntimeResult { ok: boolean; message: string; status?: RuntimeStatus; error?: { code: string; message: string }; }
