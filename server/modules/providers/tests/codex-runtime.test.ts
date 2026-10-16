import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { AnyRecord, NormalizedMessage, ProviderRuntimeContext } from '@/shared/index.js';

function setup(t: TestContext, onRequest?: (message: AnyRecord, emit: (message: AnyRecord) => void) => boolean) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { queueMicrotask(() => child.emit('close', 0)); return true; } });
  const emit = (message: AnyRecord) => child.stdout.write(`${JSON.stringify(message)}\n`);
  const calls: AnyRecord[] = [];
  let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += String(chunk);
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      calls.push(message);
      if (onRequest?.(message, emit)) continue;
      if (message.method === 'initialize') emit({ id: message.id, result: {} });
      if (message.method === 'thread/start' || message.method === 'thread/resume') emit({ id: message.id, result: { thread: { id: 'native-thread' } } });
      if (message.method === 'turn/start') {
        emit({ method: 'turn/started', params: { threadId: 'native-thread', turn: { id: 'turn-1' } } });
        emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
        queueMicrotask(() => emit({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } }));
      }
      if (message.method === 'turn/steer') emit({ id: message.id, result: { turnId: 'turn-1' } });
    }
  });
  t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: (raw) => [raw as NormalizedMessage],
    isProviderInstalled: async () => true,
  };
  const messages: AnyRecord[] = [];
  const writer = { isWebSocketWriter: true, send: (message: unknown) => { messages.push(message as AnyRecord); } };
  return { child, emit, calls, context, messages, writer };
}

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with permissions ${permissionMode}`, async (t) => {
      const fixture = setup(t);
      fixture.context.resolveProviderSessionId = () => resumed ? 'native-thread' : null;
      await codexRuntime.run('hello', { sessionId: 'app-session', permissionMode }, fixture.writer, fixture.context);
      const start = fixture.calls.find((call) => call.method === (resumed ? 'thread/resume' : 'thread/start'))!;
      assert.equal(start.params.sandbox, permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(start.params.approvalPolicy, ['acceptEdits', 'bypassPermissions'].includes(permissionMode!) ? 'never' : 'on-request');
      assert.ok(fixture.messages.some((message) => message.kind === 'complete' && message.exitCode === 0));
    });
  }
}

test('image-only input supplies text and app-server image items', async (t) => {
  const f = setup(t);
  await codexRuntime.run(' \n ', { images: [{ path: '/tmp/image.png', mimeType: 'image/png' }] }, f.writer, f.context);
  assert.deepEqual(f.calls.find((call) => call.method === 'turn/start')?.params.input, [
    { type: 'text', text: 'Please analyze the attached image(s).', text_elements: [] },
    { type: 'localImage', path: '/tmp/image.png' },
  ]);
});

test('streams partial prose, steers the active turn and completes without waiting for child exit', async (t) => {
  const f = setup(t, (message, emit) => {
    if (message.method !== 'turn/start') return false;
    emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
    return true;
  });
  const run = codexRuntime.run('hello', { sessionId: 'app-session' }, f.writer, f.context);
  await new Promise((resolve) => setImmediate(resolve));
  f.emit({ method: 'item/started', params: { item: { type: 'agentMessage', id: 'a', text: '' } } });
  f.emit({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'Hello' } });
  f.emit({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: ' world' } });
  assert.ok(f.messages.some((message) => message.itemId === 'a' && message.message?.content === 'Hello world'));
  assert.equal(await codexRuntime.steer('app-session', 'change direction'), true);
  assert.equal(f.calls.find((call) => call.method === 'turn/steer')?.params.expectedTurnId, 'turn-1');
  f.emit({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  assert.equal(await codexRuntime.steer('app-session', 'late message'), false);
  assert.equal(f.messages.filter((message) => message.kind === 'complete').length, 1);
});

test('question options and custom answers are returned using original question ids', async (t) => {
  const f = setup(t, (message, emit) => {
    if (message.method !== 'turn/start') return false;
    emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
    return true;
  });
  const run = codexRuntime.run('ask me', { sessionId: 'questions' }, f.writer, f.context);
  await new Promise((resolve) => setImmediate(resolve));
  f.emit({ id: 99, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'color', question: 'Pick a color?', header: 'Color', options: [{ label: 'Blue', description: 'Sea' }] }, { id: 'note', question: 'Any note?' }] } });
  const pending = codexRuntime.permissions.listPending('questions')[0]!;
  assert.equal(pending.toolName, 'AskUserQuestion');
  assert.equal(pending.input.questions[0].options[0].label, 'Blue');
  codexRuntime.permissions.resolve(pending.requestId, { allow: true, updatedInput: { answers: { 'Pick a color?': 'Blue', 'Any note?': 'my custom answer' } } });
  assert.deepEqual(f.calls.find((call) => call.id === 99)?.result, { answers: { color: { answers: ['Blue'] }, note: { answers: ['my custom answer'] } } });
  assert.deepEqual(codexRuntime.permissions.listPending('questions'), []);
  f.emit({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  await run;
});

test('child crash releases a waiting turn and reports failure', async (t) => {
  const f = setup(t, (message, emit) => {
    if (message.method !== 'turn/start') return false;
    emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
    queueMicrotask(() => f.child.emit('close', 1));
    return true;
  });
  await codexRuntime.run('hello', { sessionId: 'crash' }, f.writer, f.context);
  assert.ok(f.messages.some((message) => message.kind === 'error'));
  assert.ok(f.messages.some((message) => message.kind === 'complete' && message.exitCode === 1));
});

test('nonblocking questions stay answerable after completion and are published only once', async (t) => {
  const f = setup(t, (message, emit) => {
    if (message.method !== 'turn/start') return false;
    emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
    return true;
  });
  const run = codexRuntime.run('ask', { sessionId: 'async-question' }, f.writer, f.context);
  await new Promise((resolve) => setImmediate(resolve));
  const item = { type: 'agentMessage', id: 'question-1', text: 'Pick one', questions: [{ title: 'Choose?', options: ['Blue', 'Green'] }] };
  f.emit({ method: 'item/started', params: { item } });
  const request = codexRuntime.permissions.listPending('async-question')[0]!;
  assert.equal(request.input.asyncUserInput, true);
  f.emit({ method: 'item/completed', params: { item } });
  assert.equal(f.messages.filter((m) => m.kind === 'permission_request').length, 1);
  f.emit({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  assert.equal(codexRuntime.permissions.listPending('async-question').length, 1);
  codexRuntime.permissions.resolve(request.requestId, { allow: true });
  assert.deepEqual(codexRuntime.permissions.listPending('async-question'), []);
});

test('steering during the first model lookup waits for the active turn id', async (t) => {
  const f = setup(t, (message, emit) => {
    if (message.method !== 'turn/start') return false;
    emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
    return true;
  });
  let release!: () => void;
  const modelReady = new Promise<void>((resolve) => { release = resolve; });
  f.context.resolveResumeModel = async () => { await modelReady; return 'test-model'; };
  const run = codexRuntime.run('hello', { sessionId: 'starting' }, f.writer, f.context);
  const steer = codexRuntime.steer('starting', 'early follow-up');
  release();
  assert.equal(await steer, true);
  f.emit({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  await run;
});
