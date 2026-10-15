import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { liveCatalogsEnabled, liveCodexCatalog, toClaudeCatalog, toCodexCatalog } from './model-catalog.js';

const fallback = {
  OPTIONS: [
    { value: 'default', label: 'Default' },
    { value: 'opusplan', label: 'Opus Plan', description: 'plan with Opus' },
  ],
  DEFAULT: 'default',
};
const ultracode = { value: 'ultracode', description: 'x' };

describe('toClaudeCatalog', () => {
  it('maps SDK rows, adds ultracode on xhigh-capable models and keeps the opusplan alias', () => {
    const catalog = toClaudeCatalog([
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'haiku', displayName: 'Haiku', description: 'Haiku 5.5', supportedEffortLevels: ['low', 'medium'] },
      { value: 'legacy', displayName: 'Legacy', description: 'no effort' },
    ] as never, fallback, ultracode);
    assert.equal(catalog.DEFAULT, 'default');
    assert.deepEqual(catalog.OPTIONS.map((o) => o.value), ['default', 'haiku', 'legacy', 'opusplan']);
    assert.deepEqual(catalog.OPTIONS[0].effort?.values.map((v) => v.value), ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
    assert.equal(catalog.OPTIONS[0].effort?.default, 'high');
    assert.deepEqual(catalog.OPTIONS[1].effort, { default: 'medium', values: [{ value: 'low' }, { value: 'medium' }] });
    assert.equal(catalog.OPTIONS[2].effort, undefined);
  });
});

describe('toCodexCatalog', () => {
  it('maps model/list rows, hides hidden models and uses the account default', () => {
    const catalog = toCodexCatalog([
      { model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] },
      { model: 'secret', hidden: true },
      { id: 'gpt-6-luna', displayName: 'GPT-6-Luna', defaultReasoningEffort: 'bogus', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
    ], fallback);
    assert.ok(catalog);
    assert.equal(catalog.DEFAULT, 'gpt-6.1-sol');
    assert.deepEqual(catalog.OPTIONS.map((o) => o.value), ['gpt-6.1-sol', 'gpt-6-luna']);
    assert.deepEqual(catalog.OPTIONS[0].effort, { default: 'low', values: [{ value: 'low' }, { value: 'ultra' }] });
    assert.equal(catalog.OPTIONS[1].effort?.default, 'medium');
  });

  it('returns null for an empty list so the curated catalog is used', () => {
    assert.equal(toCodexCatalog([{ model: 'x', hidden: true }], fallback), null);
  });
});

describe('liveCatalogsEnabled', () => {
  it('is on only inside the Cockpit backend and can be switched off', async () => {
    assert.equal(liveCatalogsEnabled({}), false);
    assert.equal(liveCatalogsEnabled({ AGENT_UI_SOCKET: '/s' }), true);
    assert.equal(liveCatalogsEnabled({ AGENT_UI_SOCKET: '/s', AGENT_UI_LIVE_MODELS: '0' }), false);
    // outside Cockpit the curated catalog is returned untouched (no CLI is spawned)
    assert.equal(await liveCodexCatalog(fallback), fallback);
  });
});
