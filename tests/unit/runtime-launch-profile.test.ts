import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

test('compiled PACKAGED launch discovers repository root without CONTENTOS_APP_ROOT', async () => {
  const appRootBefore = process.env.CONTENTOS_APP_ROOT;
  delete process.env.CONTENTOS_APP_ROOT;
  try {
    const builtCoreUrl = pathToFileURL(resolve(process.cwd(), 'dist', 'packages', 'runtime-core', 'src', 'paths.js')).href;
    const builtClientUrl = pathToFileURL(resolve(process.cwd(), 'dist', 'packages', 'runtime-client', 'src', 'client.js')).href;
    const builtCore = await import(`${builtCoreUrl}?root-smoke=${Date.now()}`) as typeof import('../../packages/runtime-core/src/paths.js');
    const builtClient = await import(`${builtClientUrl}?launch-smoke=${Date.now()}`) as typeof import('../../packages/runtime-client/src/client.js');
    const config = builtCore.resolveRuntimePaths({ CONTENTOS_RUNTIME_MODE: 'PACKAGED' });
    const launch = await builtClient.resolveRuntimeHostLaunch({ env: { CONTENTOS_RUNTIME_MODE: 'PACKAGED' } });
    assert.equal(config.appRoot, process.cwd());
    assert.equal(launch.cwd, process.cwd());
    assert.equal(launch.entry, resolve(process.cwd(), 'dist', 'apps', 'runtime-host', 'src', 'main.js'));
    assert.ok(!launch.entry.includes(`${resolve(process.cwd(), 'dist', 'dist')}`));
    await access(launch.entry);
    assert.ok(!launch.args.some((arg) => arg.includes('tsx') || arg.endsWith('apps/runtime-host/src/main.ts')));
  } finally {
    if (appRootBefore === undefined) delete process.env.CONTENTOS_APP_ROOT;
    else process.env.CONTENTOS_APP_ROOT = appRootBefore;
  }
});
