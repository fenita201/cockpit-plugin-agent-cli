import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// The database module resolves its path from this env var when first imported, so set it before the dynamic import.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aui-'));
process.env.DATABASE_PATH = path.join(tmp, 'auth.db');

const runtime = await import('./cockpit-runtime.js');
const database = await import('../../server/modules/database/index.js');

after(() => {
  database.closeConnection();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('startIdleWatchdog', () => {
  const make = (state: { conns: number; runs: number }, minutes: number) => {
    let clock = 0;
    let idleCalls = 0;
    const watchdog = runtime.startIdleWatchdog({
      getConnectionCount: () => state.conns,
      getActiveRunCount: () => state.runs,
      onIdle: () => { idleCalls += 1; },
      minutes,
      pollMs: 3_600_000,
      now: () => clock,
    });
    return { watchdog, advance: (ms: number) => { clock += ms; }, idleCalls: () => idleCalls };
  };

  it('fires once after the whole idle window', () => {
    const state = { conns: 0, runs: 0 };
    const w = make(state, 1);
    w.advance(59_000); w.watchdog.tick();
    assert.equal(w.idleCalls(), 0);
    w.advance(1_000); w.watchdog.tick();
    assert.equal(w.idleCalls(), 1);
    w.advance(120_000); w.watchdog.tick();
    assert.equal(w.idleCalls(), 1);
    w.watchdog.stop();
  });

  it('a connection or a running agent resets the window', () => {
    const state = { conns: 0, runs: 0 };
    const w = make(state, 1);
    w.advance(50_000); state.conns = 1; w.watchdog.tick();
    w.advance(500_000); w.watchdog.tick();
    state.conns = 0; state.runs = 1; w.watchdog.tick();
    w.advance(500_000); w.watchdog.tick();
    assert.equal(w.idleCalls(), 0);
    state.runs = 0; w.watchdog.tick();
    w.advance(59_000); w.watchdog.tick();
    assert.equal(w.idleCalls(), 0);
    w.advance(1_000); w.watchdog.tick();
    assert.equal(w.idleCalls(), 1);
    w.watchdog.stop();
  });

  it('0 minutes never fires', () => {
    const w = make({ conns: 0, runs: 0 }, 0);
    w.advance(10 ** 9); w.watchdog.tick();
    assert.equal(w.idleCalls(), 0);
  });
});

describe('loadFeatures / isFeatureEnabled', () => {
  it('reads AGENT_UI_FEATURES_FILE and treats unknown features as disabled', () => {
    const file = path.join(tmp, 'features.json');
    fs.writeFileSync(file, JSON.stringify({ providers: { claude: true }, git: true, voice: false }));
    const loaded = runtime.loadFeatures({ AGENT_UI_FEATURES_FILE: file } as NodeJS.ProcessEnv);
    assert.equal(runtime.isFeatureEnabled('git', loaded), true);
    assert.equal(runtime.isFeatureEnabled('voice', loaded), false);
    assert.equal(runtime.isFeatureEnabled('nonexistent', loaded), false);
  });

  it('finds the repo features.json relative to the module when no override is set', () => {
    const loaded = runtime.loadFeatures({} as NodeJS.ProcessEnv);
    assert.equal(runtime.isFeatureEnabled('chat', loaded), true);
  });
});

describe('listenCockpit', () => {
  const sock = path.join(tmp, 'sub', 's.sock');
  let server: http.Server;

  before(() => {
    process.env.AGENT_UI_SOCKET = sock;
  });

  it('listens on a socket with mode 600, replaces a stale socket, and removes it on close of the owner', async () => {
    // A stale socket file left by a crashed backend must be replaced, not refused.
    fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
    fs.writeFileSync(sock, '');
    server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => { void runtime.listenCockpit(server, resolve); });
    assert.equal((fs.statSync(sock).mode & 0o777).toString(8), '600');
    assert.equal((fs.statSync(path.dirname(sock)).mode & 0o777).toString(8), '700');

    const body = await new Promise<string>((resolve, reject) => {
      http.get({ socketPath: sock, path: '/' }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    assert.equal(body, 'ok');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('exits with an error when AGENT_UI_SOCKET is missing', async () => {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', "import('./cockpit/server/cockpit-runtime.js').then(m=>m.listenCockpit({}, ()=>{}))"],
      { env: { ...process.env, AGENT_UI_SOCKET: '', DATABASE_PATH: path.join(tmp, 'x.db') }, cwd: path.resolve(import.meta.dirname, '../..') },
    );
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /AGENT_UI_SOCKET is not set/);
  });
});

describe('ensurePlatformUser', () => {
  it('seeds exactly one user named after the OS user', async () => {
    await database.initializeDatabase();
    assert.equal(database.userDb.hasUsers(), false);
    runtime.ensurePlatformUser();
    runtime.ensurePlatformUser();
    assert.equal(database.userDb.hasUsers(), true);
    assert.equal(database.userDb.getFirstUser()?.username, os.userInfo().username);
  });
});

