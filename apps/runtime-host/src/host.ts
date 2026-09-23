import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { createServiceDefinitions } from './service-definitions.js';
import { assertPortAvailable, InstanceGuard, ProcessManager, RestartBudget, resolveRuntimeConfig, resolveRuntimePaths, RuntimeStateStore, runtimeConfigEnv, ServiceRegistry, type DoctorReport, type HealthResult, type RuntimeLog, type RuntimeResult, type RuntimeState, type RuntimeStateFile, type RuntimeStatus, type ServiceDefinition, type ServiceState, type ServiceStatus } from '../../../packages/runtime-core/src/index.js';
import { runDoctor } from '../../../packages/runtime-core/src/index.js';

export interface RuntimeHostOptions { safeMode?: boolean; env?: Record<string, string | undefined>; serviceDefinitions?: ServiceDefinition[]; doctor?: (paths: ReturnType<typeof resolveRuntimePaths>, env: Record<string, string | undefined>) => Promise<DoctorReport>; }
const now = () => new Date().toISOString();
const errorValue = (error: unknown) => ({ code: typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'RUNTIME_ERROR', message: error instanceof Error ? error.message : String(error) });

export class RuntimeHost {
  readonly paths: ReturnType<typeof resolveRuntimePaths>; readonly store: RuntimeStateStore; readonly instanceId = randomUUID(); readonly controlPort: number; readonly registry = new ServiceRegistry();
  private readonly processes: ProcessManager; private readonly guard: InstanceGuard; private readonly statuses = new Map<string, ServiceStatus>(); private readonly budgets = new Map<string, RestartBudget>(); private readonly healthFailures = new Map<string, number>(); private readonly serviceStartupMs = new Map<string, number>(); private readonly intentionalStops = new Set<string>(); private readonly restartTimers = new Map<string, NodeJS.Timeout>(); private readonly restartTasks = new Set<Promise<void>>(); private readonly startTasks = new Set<Promise<void>>(); private readonly env: Record<string, string | undefined>; private readonly doctor: (paths: ReturnType<typeof resolveRuntimePaths>, env: Record<string, string | undefined>) => Promise<DoctorReport>; private server: ReturnType<typeof createServer> | undefined; private state: RuntimeStateFile; private stopping = false; private monitor: NodeJS.Timeout | undefined; private healthPass: Promise<void> | undefined; private persistQueue: Promise<void> = Promise.resolve(); private lifecycleGeneration = 0; private startTask: Promise<RuntimeStatus> | undefined; private stopTask: Promise<RuntimeResult> | undefined; private readonly logs: RuntimeLog[] = [];
  constructor(options: RuntimeHostOptions = {}) {
    const baseEnv = { ...process.env, ...(options.env || {}) };
    const config = resolveRuntimeConfig(baseEnv);
    this.env = runtimeConfigEnv(config, baseEnv);
    this.paths = config; this.store = new RuntimeStateStore(this.paths); this.controlPort = config.controlPort; this.guard = new InstanceGuard(this.store, this.controlPort); this.processes = new ProcessManager(this.paths);
    this.doctor = options.doctor || runDoctor;
    const definitions = options.serviceDefinitions || createServiceDefinitions({ config, appRoot: config.appRoot, env: this.env, safeMode: options.safeMode === true }); for (const item of definitions) { this.registry.register(item); this.budgets.set(item.id, new RestartBudget(item.restartPolicy)); this.statuses.set(item.id, { id: item.id, label: item.label, required: item.required, kind: item.kind, state: 'STOPPED', ...(item.port ? { port: item.port } : {}), dependsOn: item.dependsOn, restartCount: 0, updatedAt: now() }); }
    this.state = { instanceId: this.instanceId, hostPid: process.pid, startedAt: now(), controlPort: this.controlPort, controlToken: randomUUID(), state: 'STOPPED', services: this.snapshotServices(), warnings: [] };
  }
  private async writeLog(item: RuntimeLog): Promise<void> { try { await mkdir(this.paths.logsRoot, { recursive: true }); await appendFile(resolve(this.paths.logsRoot, 'runtime-host.log'), JSON.stringify(item) + '\n', 'utf8'); } catch (error) { try { process.stderr.write(`[runtime-log] ${error instanceof Error ? error.message : String(error)}\n`); } catch { /* stderr is best effort */ } } }
  private log(serviceId: string, level: RuntimeLog['level'], event: string, message: string): void { const item = { timestamp: now(), serviceId, level, event, message }; this.logs.push(item); if (this.logs.length > 500) this.logs.shift(); void this.writeLog(item); }
  private snapshotServices(): ServiceStatus[] { return [...this.statuses.values()].map((item) => ({ ...item, dependsOn: [...item.dependsOn], ...(item.capability ? { capability: { ...item.capability } } : {}) })); }
  private deriveRuntimeState(): RuntimeState { if (this.stopping) return 'STOPPING'; const core = this.registry.list(false).map((item) => this.statuses.get(item.id)).filter((item): item is ServiceStatus => Boolean(item)); if (core.some((item) => item.state === 'STOPPING')) return 'STOPPING'; if (core.some((item) => item.state === 'STARTING')) return 'STARTING'; if (core.some((item) => item.state === 'FAILED' && !(this.budgets.get(item.id)?.canRestart() ?? false))) return 'FAILED'; if (core.some((item) => item.state === 'FAILED' || item.state === 'DEGRADED')) return 'DEGRADED'; if (core.some((item) => item.state !== 'READY')) return 'STARTING'; const optional = this.registry.list(true).filter((item) => !item.required).map((item) => this.statuses.get(item.id)).filter((item): item is ServiceStatus => Boolean(item)); return optional.some((item) => item.state !== 'READY') || this.state.warnings.length > 0 ? 'READY_WITH_WARNINGS' : 'READY'; }
  private async persist(state?: RuntimeStateFile['state'], warnings = this.state.warnings): Promise<void> {
    const write = this.persistQueue.catch(() => undefined).then(async () => {
      this.state = { ...this.state, state: state || this.deriveRuntimeState(), services: this.snapshotServices(), warnings: [...warnings] };
      await this.store.write(this.state);
    });
    this.persistQueue = write;
    await write;
  }
  private isCurrentLifecycle(generation: number): boolean { return !this.stopping && generation === this.lifecycleGeneration; }
  private trackRestartTask(task: Promise<void>): void { this.restartTasks.add(task); void task.finally(() => this.restartTasks.delete(task)); }
  private markIntentionalStop(id: string): void { if (this.processes.get(id)) this.intentionalStops.add(id); }
  private async stopProcessIntentionally(id: string, timeoutMs: number): Promise<void> { this.markIntentionalStop(id); try { await this.processes.stop(id, timeoutMs); } finally { this.intentionalStops.delete(id); } }
  private cancelScheduledRestart(id: string): void { const timer = this.restartTimers.get(id); if (timer) { clearTimeout(timer); this.restartTimers.delete(id); } }
  private cancelAllScheduledRestarts(): void { for (const id of this.restartTimers.keys()) this.cancelScheduledRestart(id); }
  private scheduleRestart(definition: ServiceDefinition, delay: number, generation = this.lifecycleGeneration): void { this.cancelScheduledRestart(definition.id); const timer = setTimeout(() => { this.restartTimers.delete(definition.id); if (!this.isCurrentLifecycle(generation)) return; this.trackRestartTask(this.startDefinition(definition, generation).catch(() => undefined)); }, delay); timer.unref(); this.restartTimers.set(definition.id, timer); }
  private async acquire(): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const inspection = await this.guard.inspect();
      if (inspection.disposition === 'RUNNING') throw Object.assign(new Error('ContentOS already running'), { code: 'RUNTIME_ALREADY_RUNNING', instanceId: inspection.state?.instanceId });
      if (inspection.disposition === 'STARTING') throw Object.assign(new Error('ContentOS is already starting'), { code: 'RUNTIME_ALREADY_STARTING', instanceId: inspection.state?.instanceId });
      if (inspection.disposition === 'CONFLICT') throw Object.assign(new Error('Runtime control port is occupied by another process'), { code: 'RUNTIME_CONTROL_PORT_CONFLICT', port: inspection.state?.controlPort || this.controlPort, identity: inspection.identity });
      if (inspection.disposition === 'STALE') { if (await this.guard.cleanupStale(inspection)) continue; continue; }
      try { await this.store.acquire({ instanceId: this.instanceId, hostPid: process.pid, controlPort: this.controlPort }); return; } catch (error) { if ((error as { code?: string }).code === 'RUNTIME_LOCK_EXISTS') continue; throw error; }
    }
    throw Object.assign(new Error('Runtime instance acquisition retries exhausted'), { code: 'RUNTIME_LOCK_EXISTS' });
  }
  private setState(id: string, state: ServiceState, extra: Partial<ServiceStatus> = {}): void { const current = this.statuses.get(id); if (!current) return; this.statuses.set(id, { ...current, state, ...extra, updatedAt: now() }); }
  private async runHealth(definition: ServiceDefinition): Promise<HealthResult> { const result = definition.healthCheck ? await definition.healthCheck() : definition.kind === 'PROCESS' ? (this.processes.get(definition.id) ? (definition.readiness === 'STDOUT_JSON_READY' && !this.processes.isReady(definition.id) ? { state: 'FAILED' as const, message: 'Worker bootstrap readiness signal not received' } : { state: 'READY' as const, message: definition.readiness === 'STDOUT_JSON_READY' ? 'Worker bootstrap ready' : 'Process alive' }) : { state: 'FAILED' as const, message: 'Process is not running' }) : { state: 'READY' as const }; if (definition.capabilityProbe) { try { result.capability = await definition.capabilityProbe(); } catch (error) { result.capability = { state: 'UNAVAILABLE', error: error instanceof Error ? error.message : String(error) }; } } return result; }
  private async waitReady(definition: ServiceDefinition, generation: number): Promise<void> {
    const deadline = Date.now() + definition.startupTimeoutMs;
    let last: unknown;
    while (Date.now() < deadline && this.isCurrentLifecycle(generation)) {
      try {
        const health = await this.runHealth(definition);
        if (!this.isCurrentLifecycle(generation)) return;
        const accepted = health.state === 'READY' || (!definition.required && (definition.allowDegradedReadiness === true || health.state === 'DEGRADED'));
        if (accepted) { this.setState(definition.id, health.state, health.capability ? { capability: health.capability } : {}); return; }
        last = health.message;
        if (health.state === 'DEGRADED' && definition.required) throw Object.assign(new Error(`${definition.id} degraded and not ready`), { code: 'SERVICE_DEGRADED_NOT_READY' });
        if (health.state === 'FAILED' && definition.kind === 'PROCESS' && !this.processes.get(definition.id)) throw Object.assign(new Error(`${definition.id} process exited before readiness`), { code: 'SERVICE_PROCESS_EXITED' });
      } catch (error) {
        if ((error as { code?: string }).code === 'SERVICE_PROCESS_EXITED' || (error as { code?: string }).code === 'SERVICE_DEGRADED_NOT_READY') throw error;
        if (!this.isCurrentLifecycle(generation)) return;
        last = error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    if (this.isCurrentLifecycle(generation)) throw Object.assign(new Error(`${definition.id} readiness timeout: ${last instanceof Error ? last.message : String(last || 'not ready')}`), { code: 'SERVICE_READINESS_TIMEOUT' });
  }

  private startDefinition(definition: ServiceDefinition, generation = this.lifecycleGeneration): Promise<void> {
    const task = this.startDefinitionInternal(definition, generation);
    this.startTasks.add(task);
    void task.finally(() => this.startTasks.delete(task)).catch(() => undefined);
    return task;
  }

  private async startDefinitionInternal(definition: ServiceDefinition, generation: number): Promise<void> {
    if (!this.isCurrentLifecycle(generation)) return;
    const startedAtMs = Date.now();
    this.cancelScheduledRestart(definition.id);
    this.setState(definition.id, 'STARTING');
    await this.persist('STARTING');
    if (!this.isCurrentLifecycle(generation)) return;
    try {
      if (definition.port) await assertPortAvailable(definition.port, definition.id);
      if (!this.isCurrentLifecycle(generation)) return;
      if (definition.start) await definition.start();
      if (!this.isCurrentLifecycle(generation)) return;
      if (definition.command) {
        const child = await this.processes.start(definition.id, definition.command, definition.args || [], { ...this.env, ...(definition.env || {}), CONTENTOS_SKIP_MIGRATIONS: '1', STORAGE_ROOT: this.env.STORAGE_ROOT || this.paths.storageRoot });
        if (!this.isCurrentLifecycle(generation)) { await this.stopProcessIntentionally(definition.id, definition.shutdownTimeoutMs); return; }
        this.setState(definition.id, 'STARTING', { ...(child.pid ? { pid: child.pid } : {}), startedAt: child.startedAt });
        child.child.once('exit', (code, signal) => {
          if (generation !== this.lifecycleGeneration || this.intentionalStops.delete(definition.id) || this.stopping || definition.kind !== 'PROCESS') return;
          this.log(definition.id, 'ERROR', 'PROCESS_EXIT', `exit=${code ?? 'null'} signal=${signal ?? 'null'}`);
          this.setState(definition.id, 'FAILED', { lastError: { code: 'PROCESS_EXIT', message: `exit=${code ?? 'null'}`, at: now() } });
          void this.handleCrash(definition, generation);
        });
      }
      await this.waitReady(definition, generation);
      if (!this.isCurrentLifecycle(generation)) { await this.stopProcessIntentionally(definition.id, definition.shutdownTimeoutMs); return; }
      this.serviceStartupMs.set(definition.id, Date.now() - startedAtMs);
      this.log(definition.id, 'INFO', 'READY', `${definition.label} ready`);
      await this.persist();
    } catch (error) {
      if (!this.isCurrentLifecycle(generation)) { await this.stopProcessIntentionally(definition.id, definition.shutdownTimeoutMs).catch(() => undefined); return; }
      const value = errorValue(error);
      this.setState(definition.id, 'FAILED', { lastError: { ...value, at: now() } });
      this.log(definition.id, 'ERROR', 'FAILED', value.message);
      await this.persist(undefined, [...this.state.warnings, `${definition.label}: ${value.message}`]);
      throw error;
    }
  }

  private async handleCrash(definition: ServiceDefinition, generation = this.lifecycleGeneration): Promise<void> {
    if (!this.isCurrentLifecycle(generation) || !definition.command || !definition.restartClass || definition.restartClass === 'PERMANENT' || this.restartTimers.has(definition.id)) return;
    const budget = this.budgets.get(definition.id);
    if (!budget || !budget.canRestart()) {
      this.setState(definition.id, 'FAILED', { lastError: { code: 'RESTART_BUDGET_EXHAUSTED', message: 'restart budget exhausted', at: now() } });
      await this.persist(undefined, [...this.state.warnings, `${definition.label}: restart budget exhausted`]);
      return;
    }
    const delay = budget.consume();
    this.setState(definition.id, 'STARTING', { restartCount: budget.count() });
    await this.persist();
    if (this.isCurrentLifecycle(generation)) this.scheduleRestart(definition, delay, generation);
  }
  private async cleanupStartupFailure(): Promise<void> {
    this.stopping = true;
    this.lifecycleGeneration += 1;
    if (this.monitor) { clearInterval(this.monitor); this.monitor = undefined; }
    this.cancelAllScheduledRestarts();
    if (this.healthPass) await Promise.race([this.healthPass, new Promise<void>((resolveWait) => setTimeout(resolveWait, 1_000))]);
    await Promise.allSettled([...this.restartTasks]);
    for (const definition of this.registry.reverse(true)) {
      this.markIntentionalStop(definition.id);
      try { await definition.stop?.(); } catch { /* preserve the original startup error */ }
      try { await this.processes.stop(definition.id, definition.shutdownTimeoutMs); } catch { /* preserve the original startup error */ }
      this.intentionalStops.delete(definition.id);
      this.setState(definition.id, 'STOPPED');
    }
    if (this.server) {
      const server = this.server;
      try { await Promise.race([new Promise<void>((resolveClose) => server.close(() => resolveClose())), new Promise<void>((resolveClose) => setTimeout(resolveClose, 2_000))]); } catch { /* preserve the original startup error */ }
      server.closeAllConnections?.();
      this.server = undefined;
    }
    await this.persistQueue.catch(() => undefined);
    await this.store.removeOwned({ instanceId: this.instanceId, hostPid: process.pid, controlPort: this.controlPort }).catch(() => false);
  }
  private async writeFailureReport(error: unknown, doctor: DoctorReport | undefined, startupMs: number): Promise<void> { try { await mkdir(this.paths.startupReportsRoot, { recursive: true }); const report = { timestamp: now(), instanceId: this.instanceId, appRoot: this.paths.appRoot, state: 'FAILED', error: errorValue(error), services: this.snapshotServices(), ...(doctor ? { doctor } : {}), warnings: this.state.warnings, startupMs }; const { writeFile } = await import('node:fs/promises'); await writeFile(resolve(this.paths.startupReportsRoot, `${this.instanceId}.failed.json`), JSON.stringify(report, null, 2), 'utf8'); } catch (reportError) { try { process.stderr.write(`[runtime-failure-report] ${reportError instanceof Error ? reportError.message : String(reportError)}\n`); } catch { /* best effort */ } } }
  start(): Promise<RuntimeStatus> {
    if (this.startTask) return this.startTask;
    const task = this.startInternal();
    this.startTask = task;
    void task.finally(() => { if (this.startTask === task) this.startTask = undefined; }).catch(() => undefined);
    return task;
  }

  private async startInternal(): Promise<RuntimeStatus> {
    if (!this.stopping && this.state.state !== 'STOPPED') throw Object.assign(new Error('Runtime Host already started'), { code: 'RUNTIME_ALREADY_RUNNING' });
    this.stopping = false;
    this.stopTask = undefined;
    const generation = ++this.lifecycleGeneration;
    delete this.env.CONTENTOS_RUNTIME_OWNS_PORTS;
    const started = Date.now();
    let acquired = false;
    let doctor: DoctorReport | undefined;
    try {
      await mkdir(this.paths.runtimeRoot, { recursive: true }); await mkdir(this.paths.stateRoot, { recursive: true }); await mkdir(this.paths.logsRoot, { recursive: true }); await mkdir(this.paths.startupReportsRoot, { recursive: true });
      if (!this.isCurrentLifecycle(generation)) throw Object.assign(new Error('Runtime startup was cancelled'), { code: 'RUNTIME_START_CANCELLED' });
      await this.acquire(); acquired = true;
      if (!this.isCurrentLifecycle(generation)) throw Object.assign(new Error('Runtime startup was cancelled'), { code: 'RUNTIME_START_CANCELLED' });
      this.state = { ...this.state, state: 'STARTING' }; await this.persist('STARTING');
      if (!this.isCurrentLifecycle(generation)) throw Object.assign(new Error('Runtime startup was cancelled'), { code: 'RUNTIME_START_CANCELLED' });
      doctor = await this.doctor(this.paths, this.env);
      if (!this.isCurrentLifecycle(generation)) throw Object.assign(new Error('Runtime startup was cancelled'), { code: 'RUNTIME_START_CANCELLED' });
      if (doctor.coreStartup !== 'READY') { this.state.warnings = doctor.checks.filter((item) => item.scope === 'CORE' && item.status === 'FAIL').map((item) => item.message); throw Object.assign(new Error('CORE_STARTUP_FAILED'), { code: 'CORE_STARTUP_FAILED', doctor }); }
      await this.listen();
      if (!this.isCurrentLifecycle(generation)) throw Object.assign(new Error('Runtime startup was cancelled'), { code: 'RUNTIME_START_CANCELLED' });
      this.env.CONTENTOS_RUNTIME_OWNS_PORTS = '1';
      const startupWarnings: string[] = [];
      for (const definition of this.registry.topological(true)) {
        if (!this.isCurrentLifecycle(generation)) throw Object.assign(new Error('Runtime startup was cancelled'), { code: 'RUNTIME_START_CANCELLED' });
        try { await this.startDefinition(definition, generation); }
        catch (error) {
          if (!this.isCurrentLifecycle(generation)) throw error;
          if (definition.required) throw error;
          const message = `${definition.label}: ${error instanceof Error ? error.message : String(error)}`;
          startupWarnings.push(message); this.setState(definition.id, 'DEGRADED', { lastError: { code: 'OPTIONAL_START_FAILED', message, at: now() } }); this.log(definition.id, 'WARN', 'OPTIONAL_START_FAILED', message);
        }
      }
      if (!this.isCurrentLifecycle(generation)) throw Object.assign(new Error('Runtime startup was cancelled'), { code: 'RUNTIME_START_CANCELLED' });
      const warnings = [...this.state.warnings, ...startupWarnings, ...doctor.checks.filter((item) => item.status !== 'PASS').map((item) => `${item.id}: ${item.message}`)];
      await this.persist(warnings.length ? 'READY_WITH_WARNINGS' : 'READY', warnings);
      await this.writeStartupReport(Date.now() - started, doctor);
      if (!this.isCurrentLifecycle(generation)) throw Object.assign(new Error('Runtime startup was cancelled'), { code: 'RUNTIME_START_CANCELLED' });
      this.monitor = setInterval(() => { void this.refreshHealth(generation).catch(() => undefined); }, 1_000);
      this.monitor.unref();
      return this.status();
    } catch (error) {
      const cancelledByStop = () => this.stopping && generation !== this.lifecycleGeneration;
      if (cancelledByStop()) {
        throw (error as { code?: string }).code === 'RUNTIME_START_CANCELLED'
          ? error
          : Object.assign(new Error('Runtime startup was cancelled by stop'), { code: 'RUNTIME_START_CANCELLED' });
      }
      if (acquired) {
        await this.writeFailureReport(error, doctor, Date.now() - started);
        // stop() may claim teardown ownership while the failure report is being written.
        // In that case stopInternal is waiting for this startTask and must do the only teardown.
        if (cancelledByStop()) throw Object.assign(new Error('Runtime startup was cancelled by stop'), { code: 'RUNTIME_START_CANCELLED' });
        await this.cleanupStartupFailure();
      }
      throw error;
    }
  }

  private async refreshHealth(generation = this.lifecycleGeneration): Promise<void> {
    if (!this.isCurrentLifecycle(generation)) return;
    if (this.healthPass) return this.healthPass;
    const pass = this.refreshHealthPass(generation);
    this.healthPass = pass;
    try { await pass; }
    finally { if (this.healthPass === pass) this.healthPass = undefined; }
  }

  private async refreshHealthPass(generation: number): Promise<void> {
    for (const definition of this.registry.list(true)) {
      if (!this.isCurrentLifecycle(generation)) return;
      const current = this.statuses.get(definition.id);
      if (!current || current.state === 'STOPPED' || current.state === 'STOPPING' || current.state === 'STARTING') continue;
      try {
        const health = await this.runHealth(definition);
        if (!this.isCurrentLifecycle(generation)) return;
        if (health.state === 'FAILED') {
          const failures = (this.healthFailures.get(definition.id) || 0) + 1;
          this.healthFailures.set(definition.id, failures);
          this.setState(definition.id, 'FAILED', { ...(health.capability ? { capability: health.capability } : {}), lastError: { code: 'HEALTH_FAILED', message: health.message || 'health check failed', at: now() } });
          if (definition.restartOnHealthFailure !== false && failures >= (definition.healthFailureThreshold || 3) && !this.restartTimers.has(definition.id)) {
            await this.stopProcessIntentionally(definition.id, definition.shutdownTimeoutMs);
            if (!this.isCurrentLifecycle(generation)) return;
            this.healthFailures.set(definition.id, 0);
            await this.handleCrash(definition, generation);
          }
        } else {
          this.healthFailures.set(definition.id, 0);
          this.setState(definition.id, health.state, health.capability ? { capability: health.capability } : {});
        }
      } catch (error) {
        if (!this.isCurrentLifecycle(generation)) return;
        this.setState(definition.id, 'DEGRADED', { lastError: { ...errorValue(error), at: now() } });
      }
    }
    if (this.isCurrentLifecycle(generation)) await this.persist();
  }
  private async listen(): Promise<void> { this.server = createServer((request, response) => void this.handleRequest(request, response)); await new Promise<void>((resolveListen, reject) => { this.server!.once('error', reject); this.server!.listen(this.controlPort, '127.0.0.1', () => resolveListen()); }); }
  private json(response: ServerResponse, status: number, payload: unknown): void { response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(payload)); }
  private authorized(request: IncomingMessage): boolean { return request.headers.authorization === `Bearer ${this.state.controlToken}`; }
  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> { const url = new URL(request.url || '/', `http://127.0.0.1:${this.controlPort}`); try { if (url.pathname === '/runtime/identity' && request.method === 'GET') return this.json(response, 200, { protocol: 'contentos-runtime', protocolVersion: 1, instanceId: this.instanceId, hostPid: process.pid }); if (url.pathname === '/runtime/status' && request.method === 'GET') return this.json(response, 200, this.status()); if (url.pathname === '/runtime/services' && request.method === 'GET') return this.json(response, 200, { items: this.snapshotServices() }); if (url.pathname === '/runtime/logs' && request.method === 'GET') { const serviceId = url.searchParams.get('serviceId'); const limit = Math.min(500, Number(url.searchParams.get('limit') || 100)); return this.json(response, 200, { items: this.logs.filter((item) => !serviceId || item.serviceId === serviceId).slice(-limit) }); } if (!this.authorized(request)) return this.json(response, 401, { error: { code: 'INVALID_CONTROL_TOKEN', message: 'Invalid runtime control token' } }); if (url.pathname === '/runtime/doctor' && request.method === 'POST') return this.json(response, 200, await runDoctor(this.paths, this.env)); if (url.pathname === '/runtime/stop' && request.method === 'POST') { this.json(response, 202, { ok: true, message: 'Runtime stopping' }); void this.stop('CONTROL'); return; } if (url.pathname === '/runtime/restart' && request.method === 'POST') return this.json(response, 409, { error: { code: 'RESTART_CLIENT_ORCHESTRATED', message: 'Restart must be orchestrated by Runtime Client' } }); const match = /^\/runtime\/services\/([^/]+)\/restart$/.exec(url.pathname); if (match && request.method === 'POST') return this.json(response, 200, await this.restartService(decodeURIComponent(match[1]!))); return this.json(response, 404, { error: { code: 'RUNTIME_ROUTE_NOT_FOUND', message: 'Runtime route not found' } }); } catch (error) { const value = errorValue(error); return this.json(response, 500, { error: value }); } }
  async stop(reason = 'CLI'): Promise<RuntimeResult> {
    if (this.stopTask) return this.stopTask;
    if (this.stopping) return { ok: true, message: 'Runtime stopping' };
    this.stopping = true;
    this.lifecycleGeneration += 1;
    this.cancelAllScheduledRestarts();
    if (this.monitor) { clearInterval(this.monitor); this.monitor = undefined; }
    this.stopTask = this.stopInternal(reason);
    return this.stopTask;
  }

  private async stopInternal(reason: string): Promise<RuntimeResult> {
    // Background health work becomes inert as soon as the generation changes.
    // Wait briefly for cooperative checks, then continue with process shutdown.
    if (this.healthPass) await Promise.race([this.healthPass, new Promise<void>((resolveWait) => setTimeout(resolveWait, 1_000))]);
    await Promise.allSettled([...(this.startTask ? [this.startTask] : []), ...this.restartTasks, ...this.startTasks]);
    await this.persist('STOPPING');
    for (const definition of this.registry.reverse(true)) {
      this.setState(definition.id, 'STOPPING');
      await this.persist('STOPPING');
      try { await definition.stop?.(); } catch { /* shutdown is best effort */ }
      await this.stopProcessIntentionally(definition.id, definition.shutdownTimeoutMs).catch(() => undefined);
      this.setState(definition.id, 'STOPPED');
    }
    if (this.server) {
      const server = this.server;
      await Promise.race([new Promise<void>((resolveClose) => server.close(() => resolveClose())), new Promise<void>((resolveClose) => setTimeout(resolveClose, 2_000))]);
      server.closeAllConnections?.();
      this.server = undefined;
    }
    await this.persistQueue.catch(() => undefined);
    await this.store.removeOwned({ instanceId: this.instanceId, hostPid: process.pid, controlPort: this.controlPort });
    this.state = { ...this.state, state: 'STOPPED', warnings: [...this.state.warnings, `stopped:${reason}`] };
    return { ok: true, message: 'ContentOS stopped' };
  }

  async restartService(id: string): Promise<RuntimeResult> {
    if (this.stopping) return { ok: false, message: 'Runtime is stopping', error: { code: 'RUNTIME_STOPPING', message: id } };
    const definition = this.registry.get(id);
    if (!definition) return { ok: false, message: `Unknown service: ${id}`, error: { code: 'SERVICE_NOT_FOUND', message: id } };
    if (this.registry.dependents(id, true).length) return { ok: false, message: `${id} has dependent services; restart the runtime instead`, error: { code: 'SERVICE_RESTART_REQUIRES_DEPENDENTS', message: id } };
    const generation = this.lifecycleGeneration;
    this.cancelScheduledRestart(id);
    await this.stopProcessIntentionally(id, definition.shutdownTimeoutMs);
    if (!this.isCurrentLifecycle(generation)) return { ok: false, message: 'Runtime is stopping', error: { code: 'RUNTIME_STOPPING', message: id } };
    await this.startDefinition(definition, generation);
    return { ok: true, message: `${id} restarted`, status: this.status() };
  }
  status(): RuntimeStatus { const state = this.deriveRuntimeState(); return { instanceId: this.state.instanceId, hostPid: this.state.hostPid, state, startedAt: this.state.startedAt, uptimeMs: Math.max(0, Date.now() - Date.parse(this.state.startedAt)), controlPort: this.state.controlPort, services: this.snapshotServices(), warnings: [...this.state.warnings] }; }
  private async writeStartupReport(totalStartupMs: number, doctor: DoctorReport): Promise<void> { await mkdir(this.paths.startupReportsRoot, { recursive: true }); let appVersion: string | undefined; try { appVersion = (JSON.parse(await readFile(resolve(this.paths.appRoot, 'package.json'), 'utf8')) as { version?: string }).version; } catch { /* package metadata is optional */ } const report = { timestamp: now(), instanceId: this.instanceId, appRoot: this.paths.appRoot, ...(appVersion ? { appVersion } : {}), ...(this.env.CONTENTOS_COMMIT_SHA ? { commitSha: this.env.CONTENTOS_COMMIT_SHA } : {}), totalStartupMs, serviceStartupTimes: this.snapshotServices().map((item) => ({ id: item.id, startedAt: item.startedAt, startupMs: this.serviceStartupMs.get(item.id) ?? null })), warnings: this.state.warnings, migration: this.statuses.get('migration')?.state, doctor }; await import('node:fs/promises').then((fs) => fs.writeFile(resolve(this.paths.startupReportsRoot, `${this.instanceId}.json`), JSON.stringify(report, null, 2), 'utf8')); }
}
