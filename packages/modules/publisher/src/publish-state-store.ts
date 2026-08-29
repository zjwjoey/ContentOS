import type { Pool } from 'pg';
import type { PublisherPlatformId } from '../../../contracts/src/index.js';

export type RealPublisherPlatformId = Exclude<PublisherPlatformId, 'fake-platform'>;
export type PublishStateKey = { platformId: RealPublisherPlatformId; accountId: string; idempotencyKey: string };
export type PublicationState = { status: 'PUBLISHED'; externalPostId?: string } | { status: 'UNKNOWN_EXTERNAL_STATE' };

export interface PublishStateStore {
  get(key: PublishStateKey): Promise<PublicationState | null>;
  markPublished(key: PublishStateKey, externalPostId?: string): Promise<void>;
  markUnknown(key: PublishStateKey): Promise<void>;
}

export class InMemoryPublishStateStore implements PublishStateStore {
  private readonly values = new Map<string, PublicationState>();
  private key(input: PublishStateKey): string { return `${input.platformId}:${input.accountId}:${input.idempotencyKey}`; }
  async get(input: PublishStateKey): Promise<PublicationState | null> { return this.values.get(this.key(input)) || null; }
  async markPublished(input: PublishStateKey, externalPostId?: string): Promise<void> { this.values.set(this.key(input), { status: 'PUBLISHED', ...(externalPostId ? { externalPostId } : {}) }); }
  async markUnknown(input: PublishStateKey): Promise<void> { const current = await this.get(input); if (current?.status !== 'PUBLISHED') this.values.set(this.key(input), { status: 'UNKNOWN_EXTERNAL_STATE' }); }
}

export class PostgresPublishStateStore implements PublishStateStore {
  constructor(private readonly db: Pool) {}
  async get(input: PublishStateKey): Promise<PublicationState | null> {
    const result = await this.db.query<{ status: PublicationState['status']; external_post_id: string | null }>(
      'select status, external_post_id from publisher_publication_states where platform_id = $1 and account_id = $2 and idempotency_key = $3',
      [input.platformId, input.accountId, input.idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) return null;
    return row.status === 'PUBLISHED' ? { status: 'PUBLISHED', ...(row.external_post_id ? { externalPostId: row.external_post_id } : {}) } : { status: 'UNKNOWN_EXTERNAL_STATE' };
  }
  async markPublished(input: PublishStateKey, externalPostId?: string): Promise<void> {
    await this.db.query(
      `insert into publisher_publication_states (platform_id, account_id, idempotency_key, status, external_post_id)
       values ($1, $2, $3, 'PUBLISHED', $4)
       on conflict (platform_id, account_id, idempotency_key) do update
       set status = 'PUBLISHED', external_post_id = excluded.external_post_id, updated_at = now()`,
      [input.platformId, input.accountId, input.idempotencyKey, externalPostId || null],
    );
  }
  async markUnknown(input: PublishStateKey): Promise<void> {
    await this.db.query(
      `insert into publisher_publication_states (platform_id, account_id, idempotency_key, status)
       values ($1, $2, $3, 'UNKNOWN_EXTERNAL_STATE')
       on conflict (platform_id, account_id, idempotency_key) do update
       set status = 'UNKNOWN_EXTERNAL_STATE', updated_at = now()
       where publisher_publication_states.status <> 'PUBLISHED'`,
      [input.platformId, input.accountId, input.idempotencyKey],
    );
  }
}
