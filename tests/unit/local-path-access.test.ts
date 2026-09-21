import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalPathAccessService } from '../../packages/modules/local-path/src/index.js';

function fakeDb(grants: Array<Record<string, unknown>> = []) {
  let inserted = 0;
  return {
    get inserted() { return inserted; },
    async query(sql: string, params?: unknown[]) {
      if (sql.startsWith('insert into local_path_grants')) {
        inserted += 1;
        const path = String(params?.[0]); const canonical = String(params?.[1]); const kind = String(params?.[2]);
        return { rows: [{ id: `grant-${inserted}`, path, canonical_path: canonical, kind, mode: params?.[3], source: params?.[4], created_at: 'now', last_used_at: 'now' }] };
      }
      if (sql.startsWith('select id::text, canonical_path')) return { rows: grants };
      if (sql.startsWith('select id::text,path')) return { rows: grants };
      return { rows: [] };
    },
  } as unknown as import('pg').Pool & { readonly inserted: number };
}

test('native picker folder grants authorize children and deduplicate canonical paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-path-grant-'));
  const child = join(root, 'nested'); await mkdir(child); await writeFile(join(child, 'voice.wav'), 'fixture');
  const db = fakeDb(); const service = new LocalPathAccessService({ db });
  const first = await service.grantPath({ path: root, purpose: 'MEDIA_ROOT' });
  const second = await service.grantPath({ path: resolve(root, '.') , purpose: 'MEDIA_ROOT' });
  assert.equal(first.canonicalPath, second.canonicalPath);
  assert.equal(db.inserted, 2, 'database upsert is idempotent at the unique key even when called twice');
  const childService = new LocalPathAccessService({ db: fakeDb([{ id: first.id, canonical_path: first.canonicalPath, kind: 'MEDIA_ROOT', mode: 'READ', path: root, source: 'NATIVE_PICKER', created_at: 'now', last_used_at: 'now' }]) });
  assert.equal((await childService.authorize(join(child, 'voice.wav'), 'VOICE_FILE')).toLocaleLowerCase(), (await childService.canonicalize(join(child, 'voice.wav'))).toLocaleLowerCase());
});

test('output folder grants require write access and file grants stay exact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-output-grant-')); const output = join(root, 'output'); await mkdir(output);
  const db = fakeDb(); const service = new LocalPathAccessService({ db });
  const grant = await service.grantPath({ path: output, purpose: 'OUTPUT_ROOT' });
  assert.equal(grant.kind, 'OUTPUT_ROOT'); assert.equal(grant.mode, 'WRITE');
  const file = join(output, 'voice.mp3'); await writeFile(file, 'fixture');
  const fileCanonical = await service.canonicalize(file);
  const fileService = new LocalPathAccessService({ db: fakeDb([{ id: 'file', canonical_path: fileCanonical, kind: 'VOICE_FILE', mode: 'READ', path: file, source: 'NATIVE_PICKER', created_at: 'now', last_used_at: 'now' }]) });
  assert.equal((await fileService.authorize(file, 'VOICE_FILE')).toLocaleLowerCase(), fileCanonical.toLocaleLowerCase());
  await assert.rejects(() => fileService.authorize(output, 'VOICE_FILE'), /LOCAL_PATH_FILE_REQUIRED/);
});

test('environment roots remain a deployment fallback for manual paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-env-grant-')); const file = join(root, 'clip.mp4'); await writeFile(file, 'fixture');
  const previous = process.env.CONTENTOS_LOCAL_MEDIA_ROOTS; process.env.CONTENTOS_LOCAL_MEDIA_ROOTS = root;
  try { const service = new LocalPathAccessService({ db: fakeDb() }); assert.equal((await service.authorize(file, 'PRIORITY_ASSET')).toLocaleLowerCase(), (await service.canonicalize(file)).toLocaleLowerCase()); }
  finally { if (previous === undefined) delete process.env.CONTENTOS_LOCAL_MEDIA_ROOTS; else process.env.CONTENTOS_LOCAL_MEDIA_ROOTS = previous; }
});

test('JIANYING_DRAFT authorize accepts both files and directories without weakening other purposes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-jianying-path-policy-'));
  const file = join(root, 'draft_content.json'); const draftDirectory = join(root, 'draft'); await mkdir(draftDirectory); await writeFile(file, '{}');
  const previous = process.env.CONTENTOS_LOCAL_MEDIA_ROOTS; process.env.CONTENTOS_LOCAL_MEDIA_ROOTS = root;
  try {
    const service = new LocalPathAccessService({ db: fakeDb() });
    await service.grantPath({ path: file, purpose: 'JIANYING_DRAFT' });
    await service.authorize(file, 'JIANYING_DRAFT');
    await service.grantPath({ path: draftDirectory, purpose: 'JIANYING_DRAFT' });
    await service.authorize(draftDirectory, 'JIANYING_DRAFT');
    await service.grantPath({ path: file, purpose: 'PRIORITY_ASSET' });
    await service.authorize(file, 'PRIORITY_ASSET');
    await assert.rejects(() => service.authorize(draftDirectory, 'PRIORITY_ASSET'), /LOCAL_PATH_FILE_REQUIRED/);
    await assert.rejects(() => service.authorize(file, 'MEDIA_ROOT'), /LOCAL_PATH_DIRECTORY_REQUIRED/);
  } finally {
    if (previous === undefined) delete process.env.CONTENTOS_LOCAL_MEDIA_ROOTS; else process.env.CONTENTOS_LOCAL_MEDIA_ROOTS = previous;
    await rm(root, { recursive: true, force: true });
  }
});
