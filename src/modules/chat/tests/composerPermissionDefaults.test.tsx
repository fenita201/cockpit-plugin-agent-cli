import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import ComposerPermissionMenu from '@/modules/chat/composer/ComposerPermissionMenu';

test('Codex permissions expose project and account defaults without saving them implicitly', () => {
  const onSelect = vi.fn();
  const onSave = vi.fn();
  render(<ComposerPermissionMenu permissionMode="acceptEdits" permissionModes={['default', 'acceptEdits', 'bypassPermissions']}
    providerLabel="Codex" onSelectPermissionMode={onSelect} onSavePermissionDefault={onSave} />);
  fireEvent.click(screen.getByRole('button'));
  assert.ok(screen.getByRole('menuitemradio', { name: /Edit in project/ }));
  assert.ok(screen.getByRole('menuitemradio', { name: /Full access/ }));
  assert.equal(onSave.mock.calls.length, 0);
  fireEvent.click(screen.getByRole('button', { name: 'For this project' }));
  assert.deepEqual(onSave.mock.calls[0], ['project']);
  assert.equal(onSelect.mock.calls.length, 0);
});
