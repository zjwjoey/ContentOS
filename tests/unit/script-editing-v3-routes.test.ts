import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerScriptEditingV3Routes } from '../../apps/api/src/script-editing-v3-routes.js';
import type { JianyingRuntimeLocator } from '../../packages/modules/video/src/index.js';

test('Jianying runtime diagnostics expose safe status without filesystem paths', async () => {
  const app = Fastify({ logger: false });
  const runtime = {
    async getRuntimeStatus() {
      return {
        platform: 'win32' as const,
        helper: { status: 'AVAILABLE' as const, configured: true, path: 'C:\\private\\jianying-draft-helper.exe' },
        dll: { status: 'AVAILABLE' as const, configured: true, path: 'C:\\private\\videoeditor.dll' },
        encryptedDraftSupport: 'READY' as const,
      };
    },
  } as unknown as JianyingRuntimeLocator;
  registerScriptEditingV3Routes(app, {
    db: {} as never,
    jobs: {} as never,
    video: {} as never,
    assets: {} as never,
    localMedia: {} as never,
    jianyingRuntime: runtime,
  });
  const response = await app.inject({ method: 'GET', url: '/api/v1/edit/v3/jianying/runtime' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    platform: 'win32',
    helperConfigured: true,
    helperAvailable: true,
    helperName: 'jianying-draft-helper.exe',
    dllConfigured: true,
    dllAvailable: true,
    dllName: 'videoeditor.dll',
    encryptedDraftSupport: 'READY',
  });
  assert.equal(response.body.includes('C:\\private'), false);
  await app.close();
});
