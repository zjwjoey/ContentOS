export type WorkerStatus = 'STARTING' | 'READY' | 'DRAINING' | 'STOPPED';
export type JobHandler = (payload: unknown) => Promise<unknown>;

export class WorkerRuntime {
  private statusValue: WorkerStatus = 'STARTING';
  private readonly handlers = new Map<string, JobHandler>();
  constructor(readonly workerId: string) {}
  register(type: string, handler: JobHandler): void {
    if (this.statusValue !== 'STARTING') throw new Error('handlers must be registered before start');
    if (this.handlers.has(type)) throw new Error(`handler already registered: ${type}`);
    this.handlers.set(type, handler);
  }
  handlerTypes(): string[] { return [...this.handlers.keys()].sort(); }
  async execute(type: string, payload: unknown): Promise<unknown> {
    if (this.statusValue !== 'READY') throw new Error('worker is not ready');
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`handler not registered: ${type}`);
    return handler(payload);
  }
  async start(): Promise<void> { this.statusValue = 'READY'; }
  async shutdown(_signal: string): Promise<void> { this.statusValue = 'DRAINING'; this.statusValue = 'STOPPED'; }
  health(): { workerId: string; status: WorkerStatus; handlers: string[] } { return { workerId: this.workerId, status: this.statusValue, handlers: this.handlerTypes() }; }
}
