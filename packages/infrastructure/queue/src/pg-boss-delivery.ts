import { PgBoss } from 'pg-boss';

export class PgBossDelivery {
  private readonly boss: PgBoss;
  constructor(connectionString: string) { this.boss = new PgBoss({ connectionString, schema: 'contentos_queue', supervise: true }); }
  async start(): Promise<void> { await this.boss.start(); }
  async send(queue: string, payload: object): Promise<string> { await this.boss.createQueue(queue); return String(await this.boss.send(queue, payload)); }
  async stop(): Promise<void> { await this.boss.stop(); }
}
