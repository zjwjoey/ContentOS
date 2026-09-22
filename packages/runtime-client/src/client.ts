import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveRuntimePaths, RuntimeStateStore, type DoctorReport, type RuntimeLog, type RuntimeResult, type RuntimeStatus, type ServiceStatus } from '../../../packages/runtime-core/src/index.js';

export interface RuntimeClientOptions { appRoot?: string; env?: Record<string, string | undefined>; controlPort?: number; token?: string; }
export class RuntimeClient {
  private readonly store: RuntimeStateStore;
  private readonly env: Record<string, string | undefined>;
  constructor(private readonly options: RuntimeClientOptions = {}) { this.env = { ...process.env, ...(options.env || {}) }; this.store = new RuntimeStateStore(resolveRuntimePaths(this.env)); }
  async state() { return this.store.read(); }
  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const state = await this.store.read(); if (!state) throw Object.assign(new Error('RUNTIME_NOT_RUNNING'), { code: 'RUNTIME_NOT_RUNNING' });
    const response = await fetch(`http://127.0.0.1:${state.controlPort}${path}`, { method, headers: { ...(state.controlToken ? { authorization: `Bearer ${state.controlToken}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json().catch(() => ({})); if (!response.ok) throw Object.assign(new Error(payload?.error?.message || `Runtime request failed (${response.status})`), { code: payload?.error?.code || 'RUNTIME_REQUEST_FAILED' }); return payload as T;
  }
  async getStatus(): Promise<RuntimeStatus> { return this.request<RuntimeStatus>('/runtime/status'); }
  async getServices(): Promise<ServiceStatus[]> { return (await this.request<{ items: ServiceStatus[] }>('/runtime/services')).items; }
  async runDoctor(): Promise<DoctorReport> { return this.request<DoctorReport>('/runtime/doctor', 'POST'); }
  async stop(): Promise<RuntimeResult> { return this.request<RuntimeResult>('/runtime/stop', 'POST'); }
  async restart(): Promise<RuntimeResult> { return this.request<RuntimeResult>('/runtime/restart', 'POST'); }
  async restartService(serviceId: string): Promise<RuntimeResult> { return this.request<RuntimeResult>(`/runtime/services/${encodeURIComponent(serviceId)}/restart`, 'POST'); }
  async getLogs(query?: { serviceId?: string; limit?: number }): Promise<RuntimeLog[]> { const suffix = new URLSearchParams({ ...(query?.serviceId ? { serviceId: query.serviceId } : {}), ...(query?.limit ? { limit: String(query.limit) } : {}) }); return (await this.request<{ items: RuntimeLog[] }>(`/runtime/logs?${suffix}`)).items; }
  static async spawnHost(options: { safeMode?: boolean; foreground?: boolean; env?: Record<string, string | undefined> } = {}): Promise<void> {
    const appRoot = resolve(options.env?.CONTENTOS_APP_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));
    const runner = resolve(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'); const entry = resolve(appRoot, 'apps', 'runtime-host', 'src', 'main.ts');
    if (options.foreground) { await import(entry); return; }
    const child = spawn(process.execPath, [runner, entry, ...(options.safeMode ? ['--safe'] : [])], { cwd: appRoot, env: { ...process.env, ...(options.env || {}) }, detached: true, stdio: 'ignore', windowsHide: true }); child.unref();
  }
}
