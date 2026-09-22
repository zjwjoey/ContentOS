import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceDefinitions } from '../../apps/runtime-host/src/service-definitions.js';
import { resolveRuntimeConfig } from '../../packages/runtime-core/src/index.js';

test('development launch profile uses source runners while packaged profile uses built JS', () => {
  const development = createServiceDefinitions({ appRoot: process.cwd(), env: { CONTENTOS_RUNTIME_MODE: 'DEVELOPMENT', PORT: '3000', WEB_PORT: '3001' }, safeMode: true, config: resolveRuntimeConfig({ CONTENTOS_APP_ROOT: process.cwd(), CONTENTOS_RUNTIME_MODE: 'DEVELOPMENT' }) });
  const packaged = createServiceDefinitions({ appRoot: process.cwd(), env: { CONTENTOS_RUNTIME_MODE: 'PACKAGED', PORT: '3000', WEB_PORT: '3001' }, safeMode: true, config: resolveRuntimeConfig({ CONTENTOS_APP_ROOT: process.cwd(), CONTENTOS_RUNTIME_MODE: 'PACKAGED' }) });
  assert.ok(development.find((item) => item.id === 'api')?.args?.some((arg) => arg.includes('tsx')));
  assert.ok(!packaged.find((item) => item.id === 'api')?.args?.some((arg) => arg.includes('tsx')));
  assert.ok(packaged.find((item) => item.id === 'web')?.args?.includes('start'));
});
