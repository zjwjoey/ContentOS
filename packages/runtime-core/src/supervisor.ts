import type { ServiceDefinition } from './types.js';

export class RestartBudget {
  private readonly events: number[] = [];
  constructor(private readonly policy: ServiceDefinition['restartPolicy']) {}
  canRestart(now = Date.now()): boolean { while (this.events[0] !== undefined && now - this.events[0] > this.policy.windowMs) this.events.shift(); return this.policy.enabled && this.events.length < this.policy.maxRestarts; }
  consume(now = Date.now()): number { this.events.push(now); return this.policy.backoffMs[Math.min(this.events.length - 1, this.policy.backoffMs.length - 1)] || 0; }
  count(): number { return this.events.length; }
}
