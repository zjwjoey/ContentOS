import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { PublisherService } from '../../packages/modules/publisher/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

test('Publisher public ExternalPost reader is project scoped and exposes only safe fields', async () => {
  const db = await createDatabase(databaseUrl);
  let projectA = '';
  let projectB = '';
  try {
    await migrateUp(db);
    const projects = new ProjectService(db);
    projectA = (await projects.create(`Reader A ${randomUUID()}`)).id;
    projectB = (await projects.create(`Reader B ${randomUUID()}`)).id;
    const publisher = new PublisherService(db);
    const makePost = async (projectId: string, suffix: string) => {
      const assetId = `asset-reader-${suffix}-${randomUUID()}`;
      const checksum = `sha256:${randomUUID()}`;
      await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, projectId, 'VIDEO_RENDER', checksum, 1, `renders/${assetId}.mp4`, 'READY', {}]);
      const account = await publisher.createAccount({ projectId, platformId: 'fake-platform', displayName: `Fake ${suffix}`, credentialRef: 'credential-ref', profileKey: `profile-${suffix}`, status: 'READY', capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: false } });
      const aggregate = await publisher.createRequest({ projectId, accountId: account.id, idempotencyKey: `reader-${suffix}-${randomUUID()}`, correlationId: `correlation-${suffix}`, revision: { assetId, assetChecksum: checksum, title: 'Reader', description: '', desiredPublishAt: null, createdBy: 'test' } });
      await publisher.transitionRequest(aggregate.request.id, 'QUEUED');
      await publisher.transitionRequest(aggregate.request.id, 'PUBLISHING');
      await publisher.transitionRequest(aggregate.request.id, 'PUBLISHED');
      return publisher.recordExternalPost({ requestId: aggregate.request.id, accountId: account.id, platformId: 'fake-platform', externalPostId: `external-${suffix}`, externalUrl: `https://fake.example/${suffix}` });
    };
    const postA = await makePost(projectA, 'a');
    const postB = await makePost(projectB, 'b');
    assert.deepEqual(await publisher.getExternalPost(projectA, postA.id), postA);
    assert.equal(await publisher.getExternalPost(projectA, postB.id), null);
    assert.equal(await publisher.getExternalPost(projectA, 'missing-external-post'), null);
  } finally {
    if (projectA || projectB) {
      await db.query('delete from publisher_external_posts where request_id in (select id from publisher_requests where project_id = any($1::text[]))', [[projectA, projectB].filter(Boolean)]);
      await db.query('update publisher_requests set current_revision_id = null where project_id = any($1::text[])', [[projectA, projectB].filter(Boolean)]);
      await db.query('delete from publisher_request_revisions where request_id in (select id from publisher_requests where project_id = any($1::text[]))', [[projectA, projectB].filter(Boolean)]);
      await db.query('delete from publisher_requests where project_id = any($1::text[])', [[projectA, projectB].filter(Boolean)]);
      await db.query('delete from publisher_accounts where project_id = any($1::text[])', [[projectA, projectB].filter(Boolean)]);
      await db.query('delete from assets where project_id = any($1::text[])', [[projectA, projectB].filter(Boolean)]);
      await db.query('delete from content_projects where id = any($1::text[])', [[projectA, projectB].filter(Boolean)]);
    }
    await db.end();
  }
});

