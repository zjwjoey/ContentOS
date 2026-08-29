import type { Pool } from 'pg';
import type { FakeOutcome } from './fake-publisher.js';

export class FakePublisherSimulationService {
  constructor(private readonly db: Pool) {}

  async get(projectId: string, accountId: string): Promise<FakeOutcome> {
    await this.requireFakeAccount(projectId, accountId);
    return this.getForAccount(accountId);
  }

  async set(projectId: string, accountId: string, outcome: FakeOutcome): Promise<FakeOutcome> {
    await this.requireFakeAccount(projectId, accountId);
    const result = await this.db.query<{ outcome: FakeOutcome }>("insert into publisher_fake_simulations (account_id, outcome) values ($1, $2) on conflict (account_id) do update set outcome = excluded.outcome, updated_at = now() returning outcome", [accountId, outcome]);
    return result.rows[0]?.outcome || outcome;
  }

  async getForAccount(accountId: string): Promise<FakeOutcome> {
    const result = await this.db.query<{ outcome: FakeOutcome }>('select outcome from publisher_fake_simulations where account_id = $1', [accountId]);
    return result.rows[0]?.outcome || 'SUCCESS';
  }

  private async requireFakeAccount(projectId: string, accountId: string): Promise<void> {
    const result = await this.db.query('select id from publisher_accounts where project_id = $1 and id = $2 and platform_id = $3', [projectId, accountId, 'fake-platform']);
    if (!result.rowCount) throw new Error('Fake Publisher account not found for this project');
  }
}
