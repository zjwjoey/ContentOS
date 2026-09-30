import { EventEmitter } from 'node:events';
import { allocateRuntimePorts, resolveRuntimeConfig, resolveRuntimePaths } from '../../../../packages/runtime-core/src/index.js';
import { RuntimeClient } from '../../../../packages/runtime-client/src/index.js';
import type { DesktopRuntimeError, DesktopRuntimePhase, DesktopRuntimeResult, DesktopRuntimeSnapshot } from '../../../../packages/desktop-contract/src/index.js';

const now = () => new Date().toISOString();
const errorValue = (error: unknown): DesktopRuntimeError => ({ code: typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'DESKTOP_RUNTIME_ERROR', message: error instanceof Error ? error.message : String(error), at: now() });

export class DesktopRuntimeManager extends EventEmitter {
  private client: RuntimeClient | undefined;
  private snapshotValue: DesktopRuntimeSnapshot;
  private poller: NodeJS.Timeout | undefined;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly env: Record<string, string | undefined> = process.env) {
    super();
    this.snapshotValue = { apiVersion: 1, phase: 'STOPPED', status: null, error: null, logRoot: resolveRuntimePaths(env).logsRoot };
  }

  snapshot(): DesktopRuntimeSnapshot { return structuredClone(this.snapshotValue); }
  private setSnapshot(next: Partial<DesktopRuntimeSnapshot>): DesktopRuntimeSnapshot { this.snapshotValue = { ...this.snapshotValue, ...next }; this.emit('status', this.snapshot()); return this.snapshot(); }
  private phaseFrom(status: { state: string }): DesktopRuntimePhase { return ['READY', 'READY_WITH_WARNINGS', 'DEGRADED', 'FAILED', 'STOPPING', 'STARTING'].includes(status.state) ? status.state as DesktopRuntimePhase : 'STOPPED'; }
  private runtimeClient(): RuntimeClient { if (!this.client) this.client = new RuntimeClient({ env: this.env }); return this.client; }

  private async prepareRuntimeClient(): Promise<RuntimeClient> {
    const ports = await allocateRuntimePorts(this.env);
    this.env.PORT ||= String(ports.api);
    this.env.WEB_PORT ||= String(ports.web);
    this.env.CONTENTOS_RUNTIME_CONTROL_PORT ||= String(ports.control);
    this.env.CONTENTOS_DATABASE_PORT ||= String(ports.database);
    if (this.env.CONTENTOS_DATABASE_MODE === 'EMBEDDED' && !this.env.DATABASE_URL) {
      const user = this.env.CONTENTOS_DATABASE_USER || 'contentos';
      const password = this.env.CONTENTOS_DATABASE_PASSWORD || 'contentos-local';
      const database = this.env.CONTENTOS_DATABASE_NAME || 'contentos';
      this.env.DATABASE_URL = `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${ports.database}/${database}`;
    }
    this.client = new RuntimeClient({ env: this.env });
    this.snapshotValue = { ...this.snapshotValue, logRoot: resolveRuntimePaths(this.env).logsRoot };
    return this.client;
  }

  private async refresh(): Promise<DesktopRuntimeSnapshot> {
    try { const status = await this.runtimeClient().getStatus(); return this.setSnapshot({ phase: this.phaseFrom(status), status, error: null }); }
    catch (error) { if ((error as { code?: string }).code === 'RUNTIME_NOT_RUNNING') return this.setSnapshot({ phase: 'STOPPED', status: null, error: null }); return this.setSnapshot({ error: errorValue(error) }); }
  }
  private startPolling(): void { if (this.poller) return; this.poller = setInterval(() => { void this.refresh(); }, 1_000); this.poller.unref(); }
  private stopPolling(): void { if (this.poller) clearInterval(this.poller); this.poller = undefined; }
  private queue<T>(task: () => Promise<T>): Promise<T> { const next = this.operation.catch(() => undefined).then(task); this.operation = next.catch(() => undefined); return next; }

  async start(options: { safeMode?: boolean } = {}): Promise<DesktopRuntimeResult> {
    return this.queue(async () => {
      this.setSnapshot({ phase: 'STARTING', error: null });
      try { const status = await (await this.prepareRuntimeClient()).start(options); this.startPolling(); return { ok: true, snapshot: this.setSnapshot({ phase: this.phaseFrom(status), status, error: null }) }; }
      catch (error) { return { ok: false, snapshot: this.setSnapshot({ phase: 'FAILED', error: errorValue(error) }) }; }
    });
  }
  async stop(): Promise<DesktopRuntimeResult> {
    return this.queue(async () => {
      this.setSnapshot({ phase: 'STOPPING' });
      try { const result = await this.runtimeClient().stop(); this.stopPolling(); return { ok: result.ok, snapshot: this.setSnapshot({ phase: 'STOPPED', status: null, error: null }) }; }
      catch (error) { return { ok: false, snapshot: this.setSnapshot({ phase: 'FAILED', error: errorValue(error) }) }; }
    });
  }
  async restart(options: { safeMode?: boolean } = {}): Promise<DesktopRuntimeResult> { await this.stop(); return this.start(options); }
  async restartService(serviceId: string): Promise<DesktopRuntimeResult> { return this.queue(async () => { try { const result = await this.runtimeClient().restartService(serviceId); await this.refresh(); return { ok: result.ok, snapshot: this.snapshot() }; } catch (error) { return { ok: false, snapshot: this.setSnapshot({ error: errorValue(error) }) }; } }); }
  async doctor(): Promise<DesktopRuntimeResult> { return this.queue(async () => { try { return { ok: true, snapshot: this.snapshot(), doctor: await this.runtimeClient().runDoctor() }; } catch (error) { return { ok: false, snapshot: this.setSnapshot({ error: errorValue(error) }) }; } }); }
  async logs(query: { serviceId?: string; limit?: number } = {}): Promise<DesktopRuntimeResult> { return this.queue(async () => { try { return { ok: true, snapshot: this.snapshot(), logs: await this.runtimeClient().getLogs(query) }; } catch (error) { return { ok: false, snapshot: this.setSnapshot({ error: errorValue(error) }) }; } }); }
  async shutdown(): Promise<void> { this.stopPolling(); if (this.snapshotValue.phase !== 'STOPPED' && this.client) await this.stop(); }
  webUrl(): string { const service = this.snapshotValue.status?.services.find((item) => item.id === 'web'); const port = service?.port || resolveRuntimeConfig(this.env).webPort; return `http://127.0.0.1:${port}`; }
}
