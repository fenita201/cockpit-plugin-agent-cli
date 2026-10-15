import assert from 'node:assert/strict';
import test from 'node:test';

import { createPluginsService } from '../plugins.service.js';

type Dependencies = Parameters<typeof createPluginsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    scanPlugins: () => [], readConfig: () => ({}), saveConfig: () => undefined,
    getPluginDirectory: () => null, getPluginsDirectory: () => '/plugins',
    resolveAsset: () => null, assetIsFile: () => false, contentType: () => 'text/plain',
    install: async () => ({ name: 'plugin', dirName: 'plugin' }),
    update: async () => ({ name: 'plugin', dirName: 'plugin' }),
    uninstall: async () => undefined, startServer: async () => 4000,
    stopServer: async () => undefined, getServerPort: () => undefined,
    isServerRunning: () => false, joinPath: (...parts) => parts.join('/'),
    logError: () => undefined, ...overrides,
  };
}

test('setEnabled persists configuration and starts an enabled plugin server', async () => {
  const operations: string[] = [];
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', dirName: 'demo', server: { entry: 'server.js' } }],
    getPluginDirectory: () => '/plugins/demo',
    saveConfig: () => operations.push('save'),
    startServer: async () => { operations.push('start'); return 4000; },
  }));
  await service.setEnabled('demo', true);
  assert.deepEqual(operations, ['save', 'start']);
});

test('update and uninstall are refused (403) for bundled plugins and never reach the loader', async () => {
  const calls: string[] = [];
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'claude-usage', dirName: 'claude-usage', bundled: true }],
    update: async () => { calls.push('update'); return { name: 'claude-usage' }; },
    uninstall: async () => { calls.push('uninstall'); },
  }));
  await assert.rejects(() => service.update('claude-usage'), { statusCode: 403, code: 'PLUGIN_BUNDLED' });
  await assert.rejects(() => service.uninstall('claude-usage'), { statusCode: 403, code: 'PLUGIN_BUNDLED' });
  assert.deepEqual(calls, []);
});

test('update and uninstall still work for ordinary plugins', async () => {
  const calls: string[] = [];
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'mine', dirName: 'mine' }],
    update: async () => { calls.push('update'); return { name: 'mine' }; },
    uninstall: async () => { calls.push('uninstall'); },
  }));
  await service.update('mine');
  await service.uninstall('mine');
  assert.deepEqual(calls, ['update', 'uninstall']);
});
