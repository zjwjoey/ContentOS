import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  assertPublisherRequestTransition,
  type PlatformCapabilityProfile,
  type PublisherAccount,
  type PublisherAccountStatus,
  type PublisherAttempt,
  type PublisherAttemptOperation,
  type PublisherAttemptStatus,
  type PublisherExternalPost,
  type PublisherFailureClassification,
  type PublisherFailureCode,
  type PublisherRequest,
  type PublisherRequestRevision,
  type PublisherRequestStatus,
} from '../../../contracts/src/index.js';

export interface CreatePublisherAccountInput {
  projectId: string;
  platformId: string;
  displayName: string;
  credentialRef: string;
  profileKey: string;
  status?: PublisherAccountStatus;
  capabilitySnapshot: PlatformCapabilityProfile;
}

export interface PublisherRevisionInput {
  assetId: string;
  assetChecksum: string;
  title: string;
  description: string;
  desiredPublishAt: string | null;
  createdBy: string;
}

export interface CreatePublisherRequestInput {
  projectId: string;
  accountId: string;
  idempotencyKey: string;
  correlationId: string;
  revision: PublisherRevisionInput;
}

export interface PublisherRequestAggregate { request: PublisherRequest; revision: PublisherRequestRevision; }

export interface PublisherPublishJobPayload {
  projectId: string;
  requestId: string;
  revisionId: string;
  accountId: string;
  platformId: string;
  jobId: string;
  jobAttemptId: string;
  correlationId: string;
}

export interface StartPublisherAttemptInput {
  requestId: string;
  revisionId: string;
  operation: PublisherAttemptOperation;
  jobId: string | null;
  jobAttemptId: string | null;
}

export interface FinishPublisherAttemptInput {
  status: Exclude<PublisherAttemptStatus, 'RUNNING'>;
  failureCode?: PublisherFailureCode | null;
  failureClassification?: PublisherFailureClassification | null;
  diagnostics?: Record<string, unknown>;
}

export interface RecordPublisherExternalPostInput {
  requestId: string;
  accountId: string;
  platformId: string;
  externalPostId: string;
  externalUrl: string | null;
}

function timestamp(value: unknown): string { return new Date(String(value)).toISOString(); }
function nullableTimestamp(value: unknown): string | null { return value ? timestamp(value) : null; }
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function mapAccount(row: Record<string, unknown>): PublisherAccount {
  return {
    id: String(row.id), projectId: String(row.project_id), platformId: String(row.platform_id), displayName: String(row.display_name),
    credentialRef: String(row.credential_ref), profileKey: String(row.profile_key), status: String(row.status) as PublisherAccountStatus,
    capabilitySnapshot: objectValue(row.capability_snapshot) as unknown as PlatformCapabilityProfile,
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
  };
}

function mapRequest(row: Record<string, unknown>): PublisherRequest {
  return {
    id: String(row.id), projectId: String(row.project_id), accountId: String(row.account_id),
    currentRevisionId: row.current_revision_id ? String(row.current_revision_id) : null,
    status: String(row.status) as PublisherRequestStatus, idempotencyKey: String(row.idempotency_key),
    desiredPublishAt: nullableTimestamp(row.desired_publish_at), nextRetryAt: nullableTimestamp(row.next_retry_at),
    failureCode: row.failure_code ? String(row.failure_code) as PublisherFailureCode : null,
    failureMessage: row.failure_message ? String(row.failure_message) : null, correlationId: String(row.correlation_id),
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), publishedAt: nullableTimestamp(row.published_at),
  };
}

function mapRevision(row: Record<string, unknown>): PublisherRequestRevision {
  return {
    id: String(row.id), requestId: String(row.request_id), revision: Number(row.revision), assetId: String(row.asset_id),
    assetChecksum: String(row.asset_checksum), title: String(row.title), description: String(row.description),
    desiredPublishAt: nullableTimestamp(row.desired_publish_at), createdBy: String(row.created_by), createdAt: timestamp(row.created_at),
  };
}

function mapAttempt(row: Record<string, unknown>): PublisherAttempt {
  return {
    id: String(row.id), requestId: String(row.request_id), revisionId: String(row.revision_id), jobId: row.job_id ? String(row.job_id) : null,
    jobAttemptId: row.job_attempt_id ? String(row.job_attempt_id) : null, attemptNumber: Number(row.attempt_number),
    operation: String(row.operation) as PublisherAttemptOperation, status: String(row.status) as PublisherAttemptStatus,
    failureCode: row.failure_code ? String(row.failure_code) as PublisherFailureCode : null,
    failureClassification: row.failure_classification ? String(row.failure_classification) as PublisherFailureClassification : null,
    diagnostics: objectValue(row.diagnostics), startedAt: timestamp(row.started_at), finishedAt: nullableTimestamp(row.finished_at),
  };
}

function mapExternalPost(row: Record<string, unknown>): PublisherExternalPost {
  return {
    id: String(row.id), requestId: String(row.request_id), accountId: String(row.account_id), platformId: String(row.platform_id),
    externalPostId: String(row.external_post_id), externalUrl: row.external_url ? String(row.external_url) : null,
    firstObservedAt: timestamp(row.first_observed_at), lastReconciledAt: nullableTimestamp(row.last_reconciled_at),
  };
}

async function rollback(client: PoolClient): Promise<void> { try { await client.query('rollback'); } catch { /* preserve original failure */ } }

export class PublisherService {
  constructor(private readonly db: Pool) {}

  async createAccount(input: CreatePublisherAccountInput): Promise<PublisherAccount> {
    const id = `publisher-account-${randomUUID()}`;
    const result = await this.db.query('insert into publisher_accounts (id, project_id, platform_id, display_name, credential_ref, profile_key, status, capability_snapshot) values ($1, $2, $3, $4, $5, $6, $7, $8) returning *', [id, input.projectId, input.platformId, input.displayName, input.credentialRef, input.profileKey, input.status || 'UNVERIFIED', input.capabilitySnapshot]);
    return mapAccount(result.rows[0] as Record<string, unknown>);
  }

  async getAccount(projectId: string, accountId: string): Promise<PublisherAccount | null> {
    const result = await this.db.query('select * from publisher_accounts where project_id = $1 and id = $2', [projectId, accountId]);
    return result.rows[0] ? mapAccount(result.rows[0] as Record<string, unknown>) : null;
  }

  async listAccounts(projectId: string): Promise<PublisherAccount[]> {
    const result = await this.db.query('select * from publisher_accounts where project_id = $1 order by created_at desc, id desc', [projectId]);
    return result.rows.map((row) => mapAccount(row as Record<string, unknown>));
  }

  async createRequest(input: CreatePublisherRequestInput): Promise<PublisherRequestAggregate> {
    const client = await this.db.connect();
    try {
      await client.query('begin');
      const account = await client.query('select id from publisher_accounts where id = $1 and project_id = $2', [input.accountId, input.projectId]);
      if (!account.rowCount) throw new Error('Publisher account not found for project');
      const id = `publisher-request-${randomUUID()}`;
      const inserted = await client.query('insert into publisher_requests (id, project_id, account_id, status, idempotency_key, correlation_id) values ($1, $2, $3, $4, $5, $6) on conflict (idempotency_key) do nothing returning *', [id, input.projectId, input.accountId, 'DRAFT', input.idempotencyKey, input.correlationId]);
      if (!inserted.rowCount) {
        const existing = await client.query('select * from publisher_requests where idempotency_key = $1', [input.idempotencyKey]);
        const request = mapRequest(existing.rows[0] as Record<string, unknown>);
        const revision = await client.query('select * from publisher_request_revisions where id = $1', [request.currentRevisionId]);
        await client.query('commit');
        return { request, revision: mapRevision(revision.rows[0] as Record<string, unknown>) };
      }
      const revisionId = `publisher-revision-${randomUUID()}`;
      const revision = await client.query('insert into publisher_request_revisions (id, request_id, revision, asset_id, asset_checksum, title, description, desired_publish_at, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *', [revisionId, id, 1, input.revision.assetId, input.revision.assetChecksum, input.revision.title, input.revision.description, input.revision.desiredPublishAt, input.revision.createdBy]);
      const updated = await client.query('update publisher_requests set current_revision_id = $2, desired_publish_at = $3, updated_at = now() where id = $1 returning *', [id, revisionId, input.revision.desiredPublishAt]);
      await client.query('commit');
      return { request: mapRequest(updated.rows[0] as Record<string, unknown>), revision: mapRevision(revision.rows[0] as Record<string, unknown>) };
    } catch (error) { await rollback(client); throw error; }
    finally { client.release(); }
  }

  async getRequest(id: string): Promise<PublisherRequest | null> {
    const result = await this.db.query('select * from publisher_requests where id = $1', [id]);
    return result.rows[0] ? mapRequest(result.rows[0] as Record<string, unknown>) : null;
  }

  async listRequests(projectId: string): Promise<PublisherRequest[]> {
    const result = await this.db.query('select * from publisher_requests where project_id = $1 order by created_at desc, id desc', [projectId]);
    return result.rows.map((row) => mapRequest(row as Record<string, unknown>));
  }

  async getRequestAggregate(projectId: string, requestId: string): Promise<PublisherRequestAggregate | null> {
    const result = await this.db.query('select p.*, r.id as revision_id, r.request_id as revision_request_id, r.revision, r.asset_id, r.asset_checksum, r.title, r.description, r.desired_publish_at as revision_desired_publish_at, r.created_by, r.created_at as revision_created_at from publisher_requests p left join publisher_request_revisions r on r.id = p.current_revision_id where p.project_id = $1 and p.id = $2', [projectId, requestId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row || !row.revision_id) return null;
    return {
      request: mapRequest(row),
      revision: mapRevision({
        id: row.revision_id,
        request_id: row.revision_request_id,
        revision: row.revision,
        asset_id: row.asset_id,
        asset_checksum: row.asset_checksum,
        title: row.title,
        description: row.description,
        desired_publish_at: row.revision_desired_publish_at,
        created_by: row.created_by,
        created_at: row.revision_created_at,
      }),
    };
  }

  async buildPublishJobPayload(projectId: string, requestId: string, jobId: string, jobAttemptId: string): Promise<PublisherPublishJobPayload> {
    const aggregate = await this.getRequestAggregate(projectId, requestId);
    if (!aggregate) throw new Error('Publisher request not found for project');
    const account = await this.getAccount(projectId, aggregate.request.accountId);
    if (!account) throw new Error('Publisher account not found for project');
    return {
      projectId,
      requestId,
      revisionId: aggregate.revision.id,
      accountId: account.id,
      platformId: account.platformId,
      jobId,
      jobAttemptId,
      correlationId: aggregate.request.correlationId,
    };
  }

  async getCurrentRevision(requestId: string): Promise<PublisherRequestRevision | null> {
    const result = await this.db.query('select r.* from publisher_request_revisions r join publisher_requests p on p.current_revision_id = r.id where p.id = $1', [requestId]);
    return result.rows[0] ? mapRevision(result.rows[0] as Record<string, unknown>) : null;
  }

  async addRevision(requestId: string, input: PublisherRevisionInput): Promise<PublisherRequestRevision> {
    const client = await this.db.connect();
    try {
      await client.query('begin');
      const current = await client.query('select * from publisher_requests where id = $1 for update', [requestId]);
      if (!current.rowCount) throw new Error('Publisher request not found');
      if (String(current.rows[0].status) !== 'DRAFT') throw new Error('Only DRAFT Publisher requests can be revised');
      const next = await client.query<{ revision: number }>('select coalesce(max(revision), 0) + 1 as revision from publisher_request_revisions where request_id = $1', [requestId]);
      const revisionId = `publisher-revision-${randomUUID()}`;
      const revision = await client.query('insert into publisher_request_revisions (id, request_id, revision, asset_id, asset_checksum, title, description, desired_publish_at, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *', [revisionId, requestId, Number(next.rows[0]?.revision || 1), input.assetId, input.assetChecksum, input.title, input.description, input.desiredPublishAt, input.createdBy]);
      await client.query('update publisher_requests set current_revision_id = $2, desired_publish_at = $3, updated_at = now() where id = $1', [requestId, revisionId, input.desiredPublishAt]);
      await client.query('commit');
      return mapRevision(revision.rows[0] as Record<string, unknown>);
    } catch (error) { await rollback(client); throw error; }
    finally { client.release(); }
  }

  assertTransition(from: PublisherRequestStatus, to: PublisherRequestStatus): void { assertPublisherRequestTransition(from, to); }

  async transitionRequest(id: string, to: PublisherRequestStatus, failure?: { code?: PublisherFailureCode | null; message?: string | null }): Promise<PublisherRequest> {
    const client = await this.db.connect();
    try {
      await client.query('begin');
      const current = await client.query('select * from publisher_requests where id = $1 for update', [id]);
      if (!current.rowCount) throw new Error('Publisher request not found');
      const from = String(current.rows[0].status) as PublisherRequestStatus;
      assertPublisherRequestTransition(from, to);
      const updated = await client.query('update publisher_requests set status = $2, failure_code = $3, failure_message = $4, published_at = case when $2 = \'PUBLISHED\' then now() else published_at end, updated_at = now() where id = $1 returning *', [id, to, failure?.code || null, failure?.message || null]);
      await client.query('commit');
      return mapRequest(updated.rows[0] as Record<string, unknown>);
    } catch (error) { await rollback(client); throw error; }
    finally { client.release(); }
  }

  async startAttempt(input: StartPublisherAttemptInput): Promise<PublisherAttempt> {
    const client = await this.db.connect();
    try {
      await client.query('begin');
      const request = await client.query('select id from publisher_requests where id = $1 for update', [input.requestId]);
      if (!request.rowCount) throw new Error('Publisher request not found');
      const revision = await client.query('select id from publisher_request_revisions where id = $1 and request_id = $2', [input.revisionId, input.requestId]);
      if (!revision.rowCount) throw new Error('Publisher revision does not belong to request');
      const next = await client.query<{ attempt_number: number }>('select coalesce(max(attempt_number), 0) + 1 as attempt_number from publisher_attempts where request_id = $1', [input.requestId]);
      const id = `publisher-attempt-${randomUUID()}`;
      const result = await client.query('insert into publisher_attempts (id, request_id, revision_id, job_id, job_attempt_id, attempt_number, operation, status) values ($1, $2, $3, $4, $5, $6, $7, $8) returning *', [id, input.requestId, input.revisionId, input.jobId, input.jobAttemptId, Number(next.rows[0]?.attempt_number || 1), input.operation, 'RUNNING']);
      await client.query('commit');
      return mapAttempt(result.rows[0] as Record<string, unknown>);
    } catch (error) { await rollback(client); throw error; }
    finally { client.release(); }
  }

  async finishAttempt(id: string, input: FinishPublisherAttemptInput): Promise<PublisherAttempt> {
    const result = await this.db.query('update publisher_attempts set status = $2, failure_code = $3, failure_classification = $4, diagnostics = $5, finished_at = now() where id = $1 and status = $6 returning *', [id, input.status, input.failureCode || null, input.failureClassification || null, input.diagnostics || {}, 'RUNNING']);
    if (!result.rowCount) throw new Error('Publisher attempt is not running or does not exist');
    return mapAttempt(result.rows[0] as Record<string, unknown>);
  }

  async recordExternalPost(input: RecordPublisherExternalPostInput): Promise<PublisherExternalPost> {
    const result = await this.db.query('insert into publisher_external_posts (id, request_id, account_id, platform_id, external_post_id, external_url) values ($1, $2, $3, $4, $5, $6) on conflict (account_id, platform_id, external_post_id) do update set external_url = coalesce(publisher_external_posts.external_url, excluded.external_url), last_reconciled_at = now() returning *', [`publisher-external-${randomUUID()}`, input.requestId, input.accountId, input.platformId, input.externalPostId, input.externalUrl]);
    return mapExternalPost(result.rows[0] as Record<string, unknown>);
  }
}
