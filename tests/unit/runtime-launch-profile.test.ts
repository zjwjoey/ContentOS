import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceDefinitions } from '../../apps/runtime-host/src/service-definitions.js';
import { resolveRuntimeConfig } from '../../packages/runtime-core/src/index.js';
import { resolveRuntimeHostLaunch } from '../../packages/runtime-client/src/index.js';

test('development launch profile uses source runners while packaged profile uses built JS', () => {
  const development = createServiceDefinitions({ appRoot: process.cwd(), env: { CONTENTOS_RUNTIME_MODE: 'DEVELOPMENT', PORT: '3000', WEB_PORT: '3001' }, safeMode: true, config: resolveRuntimeConfig({ CONTENTOS_APP_ROOT: process.cwd(), CONTENTOS_RUNTIME_MODE: 'DEVELOPMENT' }) });
  const packaged = createServiceDefinitions({ appRoot: process.cwd(), env: { CONTENTOS_RUNTIME_MODE: 'PACKAGED', PORT: '3000', WEB_PORT: '3001' }, safeMode: true, config: resolveRuntimeConfig({ CONTENTOS_APP_ROOT: process.cwd(), CONTENTOS_RUNTIME_MODE: 'PACKAGED' }) });
  assert.ok(development.find((item) => item.id === 'api')?.args?.some((arg) => arg.includes('tsx')));
  assert.ok(!packaged.find((item) => item.id === 'api')?.args?.some((arg) => arg.includes('tsx')));
  assert.ok(packaged.find((item) => item.id === 'web')?.args?.includes('start'));
});

test('packaged Runtime Host launch uses the built host entry without tsx', async () => {
  const launch = await resolveRuntimeHostLaunch({ env: { CONTENTOS_APP_ROOT: process.cwd(), CONTENTOS_RUNTIME_MODE: 'PACKAGED' } });
  assert.equal(launch.command, process.execPath);
  assert.match(launch.entry, /dist[\\/]apps[\\/]runtime-host[\\/]src[\\/]main\.js$/u);
  assert.ok(!launch.args.some((arg) => arg.includes('tsx')));
  assert.ok(!launch.args.some((arg) => arg.endsWith('apps/runtime-host/src/main.ts')));
});
