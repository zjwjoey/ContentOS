import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { LocalMediaSourceService } from '../../packages/modules/asset/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { generateFixtureVideo } from '../../packages/infrastructure/ffmpeg/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

test('local media scan resolves source_path from scan files and persists a real thumbnail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-thumbnail-integration-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'contentos-thumbnail-storage-'));
  const db = await createDatabase(databaseUrl);
  const project = await new ProjectService(db).create(`Thumbnail ${randomUUID()}`);
  const scanId = `scan-${randomUUID()}`;
  const videoPath = join(root, '素材 with spaces.mp4');
  try {
    await generateFixtureVideo(videoPath, ffmpeg, 'blue', 1.5);
    await migrateUp(db);
    const service = new LocalMediaSourceService({ db, allowedRoots: [root], thumbnailRoot: join(storageRoot, 'thumbnails') });
    await service.createScan({ id: scanId, projectId: project.id, sourceRoot: root, recursive: true });
    await service.markScanRunning(scanId);
    const scan = await service.scan({ sourceRoot: root, recursive: true });
    await service.completeScan(scanId, scan);
    const fileId = `${scan.sourceRootId}:素材 with spaces.mp4`;
    const thumbnail = await service.generateThumbnail(fileId, ffmpeg);
    assert.ok(thumbnail);
    await access(thumbnail.path);
    const row = (await db.query<{ source_path: string; thumbnail_status: string; thumbnail_error: string | null }>('select f.source_path,i.thumbnail_status,i.thumbnail_error from local_media_index i join local_media_scan_files f on f.file_id=i.file_id where i.file_id=$1', [fileId])).rows[0];
    assert.equal(row?.source_path, videoPath);
    assert.equal(row?.thumbnail_status, 'READY');
    assert.equal(row?.thumbnail_error, null);
  } finally {
    await db.query('delete from content_projects where id=$1', [project.id]);
    await db.end();
    await rm(root, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
});
