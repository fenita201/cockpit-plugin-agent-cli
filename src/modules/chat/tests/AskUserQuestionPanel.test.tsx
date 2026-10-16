import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import { AskUserQuestionPanel } from '@/modules/chat/tools/InteractiveRenderers/AskUserQuestionPanel';

const request = {
  requestId: 'codex-question', toolName: 'AskUserQuestion',
  input: { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Blue', description: 'Ocean' }, { label: 'Green', description: 'Forest' }] }] },
};

test('a clicked option is submitted as the answer to the original question', () => {
  const onDecision = vi.fn();
  render(<AskUserQuestionPanel request={request} onDecision={onDecision} />);
  fireEvent.click(screen.getByRole('button', { name: /Blue/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Submit/ }));
  assert.deepEqual(onDecision.mock.calls[0], [request.requestId, {
    allow: true, updatedInput: { ...request.input, answers: { 'Which color?': 'Blue' } },
  }]);
});

test('the Other field submits a custom answer', () => {
  const onDecision = vi.fn();
  render(<AskUserQuestionPanel request={request} onDecision={onDecision} />);
  fireEvent.click(screen.getByRole('button', { name: /Other/ }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Purple' } });
  fireEvent.click(screen.getByRole('button', { name: /^Submit/ }));
  assert.deepEqual(onDecision.mock.calls[0]?.[1].updatedInput.answers, { 'Which color?': 'Purple' });
});
