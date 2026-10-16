import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { dispatchQueuedMessages, initializeQueuedMessageDispatcher, closeQueuedMessageDispatcher } from '@/modules/websocket/services/queued-message-dispatcher.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const SESSION_ID = 'queued-session';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'queued-messages-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('queuer', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Queued session');
    await runTest(Number(user.id));
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

function createRuntime(
  runs: RunCall[],
  hasBackgroundWork: (sessionId: string) => boolean = () => false,
) {
  return {
    hasRuntime: () => true,
    hasBackgroundWork,
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      runs.push({ provider, command, options });
    },
    abort: async () => true,
  } as never;
}

test('a queued message is sent by the server without a browser connection', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: {
        content: 'continue on the VPS',
        options: { model: 'claude-opus-5' },
        attachments: [{ path: '/tmp/upload.png' }],
      },
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'continue on the VPS');
    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.deepEqual(runs[0].options.attachments, []);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('a queued message stays pending while its session is busy', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send after this run' },
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
      content: 'send after this run',
    });
  });
});

test('a queued message waits for background work its session\'s last turn left running', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send after the background job' },
    });
    // Turn A ended, so its run is completed, but it backgrounded a command
    // that is still running under A's CLI process.
    const runA = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });
    runA!.writer.sendComplete({ exitCode: 0 });
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);

    let backgroundWork = true;
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, (sessionId) => sessionId === SESSION_ID && backgroundWork);

    // Starting B now would replace that process and stop the command.
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
      content: 'send after the background job',
    });

    // Once the work has reported back, B goes on the next pass.
    backgroundWork = false;
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'send after the background job');
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});


test('a long-running dispatched turn does not block a later idle session queue', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  await withIsolatedDatabase(async (userId) => {
    const runs: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      run: async (_provider: string, command: string) => {
        runs.push(command);
        if (command === 'long turn') await held;
      },
    } as never;
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'long turn' } });
    initializeQueuedMessageDispatcher(runtime);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(runs, ['long turn']);
      sessionsDb.createAppSession('second-session', 'codex', '/tmp/second-project');
      sessionDraftsDb.saveDraft(userId, 'second-session', { text: '', queuedMessage: { content: 'later turn' } });
      t.mock.timers.tick(1000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(runs, ['long turn', 'later turn']);
      t.mock.timers.tick(1000);
      assert.equal(runs.length, 2, 'claimed messages must not run twice');
    } finally {
      closeQueuedMessageDispatcher();
      release();
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
});
