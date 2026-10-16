import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * The four per-provider default models used to be four useState slots with four
 * copy-pasted reconciliation effects and a four-branch setter. They are now one
 * Record with one loop. These tests pin the behaviour that has to survive that:
 * each provider keeps its own model, under its own storage key, and choosing a
 * model persists it.
 */

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

vi.mock('@/shared/api', () => ({
  api: {
    // The preference store PATCHes through api.user; it is stubbed rather than
    // exercised here, which keeps these tests about the model record.
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      createModel: () => okJson({ success: true, data: null }),
      updateModel: () => okJson({ success: true, data: null }),
      removeModel: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderProviderState = async () => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook(() =>
    useChatProviderState({ selectedSession: null, selectedProject: null }),
  );
};

beforeEach(() => {
  localStorage.clear();
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
});

afterEach(() => {
  vi.resetModules();
});

test('each provider gets its own model from its own storage key', async () => {
  localStorage.setItem('claude-model', 'claude-stored');
  localStorage.setItem('codex-model', 'codex-stored');
  // Left behind by an install that still had the Cursor and OpenCode providers.
  localStorage.setItem('cursor-model', 'cursor-stored');
  localStorage.setItem('opencode-model', 'opencode-stored');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'claude-stored');
  });
  assert.equal(result.current.providerModels.codex, 'codex-stored');
  assert.deepEqual(Object.keys(result.current.providerModels).sort(), ['claude', 'codex']);
});

test('a provider with no stored model falls back to its own default, not another provider’s', async () => {
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  const models = result.current.providerModels;
  assert.equal(
    new Set(Object.values(models)).size,
    Object.keys(models).length,
    'each provider must have a distinct default model',
  );
});

test('choosing a model persists it under that provider’s key only', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.codex);
  });
  const claudeBefore = result.current.providerModels.claude;

  act(() => {
    result.current.setStoredProviderModel('codex', 'codex-chosen');
  });

  assert.equal(result.current.providerModels.codex, 'codex-chosen');
  assert.equal(localStorage.getItem('codex-model'), 'codex-chosen');
  assert.equal(
    result.current.providerModels.claude,
    claudeBefore,
    'setting one provider must not disturb another',
  );
  assert.equal(localStorage.getItem('claude-model'), null);
});

test('setting the same model twice keeps the record identity stable', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });
  const afterFirst = result.current.providerModels;

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });

  assert.equal(
    result.current.providerModels,
    afterFirst,
    'a no-op write must not allocate a new record and wake consumers',
  );
});

test('the active provider’s model is what currentProviderModel reports', async () => {
  // The provider selection is a stored preference; the per-provider model is
  // still a plain localStorage key.
  writeUserPreference('selectedProvider', 'codex');
  localStorage.setItem('codex-model', 'codex-active');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'codex');
  });
  assert.equal(result.current.currentProviderModel, 'codex-active');
});


test('a new conversation defaults to Codex even after choosing Claude previously', async () => {
  writeUserPreference('selectedProvider', 'claude');
  const { result } = await renderProviderState();
  assert.equal(result.current.provider, 'codex');
  act(() => result.current.setProvider('claude'));
  assert.equal(result.current.provider, 'claude');
});

test('Codex resolves session, project and global permission modes in that order', async () => {
  writeUserPreference('codexPermissions', { permissionMode: 'bypassPermissions', projectModes: { '/project-a': 'acceptEdits' } });
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const view = renderHook(({ path, id }) => useChatProviderState({
    selectedProject: { projectId: path, displayName: path, fullPath: path },
    selectedSession: { id, __provider: 'codex' },
  }), { initialProps: { path: '/project-a', id: 'permission-session-a' } });
  await waitFor(() => assert.equal(view.result.current.permissionMode, 'acceptEdits'));
  act(() => view.result.current.selectPermissionMode('default'));
  assert.equal(view.result.current.permissionMode, 'default');
  view.rerender({ path: '/project-b', id: 'permission-session-b' });
  await waitFor(() => assert.equal(view.result.current.permissionMode, 'bypassPermissions'));
  view.rerender({ path: '/project-a', id: 'permission-session-a' });
  await waitFor(() => assert.equal(view.result.current.permissionMode, 'default'));
});

test('Codex can save the selected mode for this project and for all projects', async () => {
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const view = renderHook(({ path }) => useChatProviderState({
    selectedProject: { projectId: path, displayName: path, fullPath: path }, selectedSession: null,
  }), { initialProps: { path: '/project-a' } });
  act(() => view.result.current.selectPermissionMode('bypassPermissions'));
  act(() => view.result.current.savePermissionDefault('global'));
  act(() => view.result.current.selectPermissionMode('acceptEdits'));
  act(() => view.result.current.savePermissionDefault('project'));
  // A newly mounted composer must hydrate its defaults without relying on the prior browser state.
  view.unmount();
  const next = renderHook(() => useChatProviderState({ selectedProject: { projectId: 'a', displayName: 'A', fullPath: '/project-a' }, selectedSession: null }));
  await waitFor(() => assert.equal(next.result.current.permissionMode, 'acceptEdits'));
  next.unmount();
  const other = renderHook(() => useChatProviderState({ selectedProject: { projectId: 'b', displayName: 'B', fullPath: '/project-b' }, selectedSession: null }));
  await waitFor(() => assert.equal(other.result.current.permissionMode, 'bypassPermissions'));
});

test('an unsent Codex session override does not follow the user into another project', async () => {
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const view = renderHook(({ path }) => useChatProviderState({
    selectedProject: { projectId: path, displayName: path, fullPath: path }, selectedSession: null,
  }), { initialProps: { path: '/project-a' } });
  act(() => view.result.current.selectPermissionMode('bypassPermissions'));
  view.rerender({ path: '/project-b' });
  await waitFor(() => assert.equal(view.result.current.permissionMode, 'default'));
});
