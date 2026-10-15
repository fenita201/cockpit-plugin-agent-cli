// Cockpit runtime glue for the claudecodeui backend (see cockpit/NOTES.md).
// Everything here is imported from server/index.ts through a handful of one-line patches (cockpit/PATCHES.md).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';

import { userDb } from '../../server/modules/database/index.js';

//----------------- FEATURES ------------------

export type CockpitFeatures = {
  providers: Record<string, boolean>;
  [feature: string]: boolean | Record<string, boolean>;
};

/**
 * Looks for features.json in the places it can live: an explicit env override, then relative to this file
 * (works from source `cockpit/server/` and from the compiled `dist-server/cockpit/server/`), then the cwd.
 * A missing or invalid file is an error: guessing defaults would let the server and the built frontend disagree.
 */
export function loadFeatures(env: NodeJS.ProcessEnv = process.env, moduleUrl: string = import.meta.url): CockpitFeatures {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    env.AGENT_UI_FEATURES_FILE,
    path.resolve(here, '../features.json'),
    path.resolve(here, '../../cockpit/features.json'),
    path.resolve(here, '../../../cockpit/features.json'),
    path.resolve(process.cwd(), 'cockpit/features.json'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as CockpitFeatures;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.providers !== 'object') {
      throw new Error(`[Cockpit] ${candidate} is not a valid features file`);
    }
    return parsed;
  }
  throw new Error(`[Cockpit] features.json not found (looked in: ${candidates.join(', ')})`);
}

/** Loaded once at startup; server/index.ts reads `features.<name>` to decide which modules to mount. */
export const features: CockpitFeatures = loadFeatures();

/** Truthy check that tolerates missing keys (an unknown feature is treated as disabled). */
export function isFeatureEnabled(name: string, source: CockpitFeatures = features): boolean {
  return source[name] === true;
}

//----------------- UNIX SOCKET LISTEN ------------------

function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    const done = (alive: boolean) => {
      probe.destroy();
      resolve(alive);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.setTimeout(1000, () => done(false));
  });
}

/**
 * Replaces `server.listen(PORT, HOST, cb)`. The backend only ever listens on the unix socket named by
 * AGENT_UI_SOCKET (mode 600, so only the owning user can connect). There is no standalone mode.
 */
export async function listenCockpit(server: Server, callback: () => void | Promise<void>): Promise<void> {
  const socketPath = process.env.AGENT_UI_SOCKET;
  if (!socketPath) {
    console.error('[Cockpit] AGENT_UI_SOCKET is not set: this build only runs inside Cockpit (no standalone mode).');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(socketPath)) {
    if (await probeSocket(socketPath)) {
      console.error(`[Cockpit] another backend is already listening on ${socketPath}`);
      process.exit(1);
    }
    fs.rmSync(socketPath, { force: true });
  }

  // Remove the socket on exit only if it is still the one this process created: after a restart race a newer
  // backend may own that path.
  let ownSocket: { dev: number; ino: number } | null = null;
  const removeSocket = () => {
    try {
      const current = fs.statSync(socketPath);
      if (ownSocket && current.dev === ownSocket.dev && current.ino === ownSocket.ino) fs.rmSync(socketPath, { force: true });
    } catch {
      // already gone
    }
  };
  process.on('exit', removeSocket);

  server.on('error', (error) => {
    console.error('[Cockpit] listen failed:', error);
    process.exit(1);
  });
  // Unix sockets are bound synchronously inside listen(), so the restrictive umask is only needed for that call;
  // the socket never exists with wider permissions than 600.
  const previousUmask = process.umask(0o177);
  try {
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      const info = fs.statSync(socketPath);
      ownSocket = { dev: info.dev, ino: info.ino };
      void callback();
    });
  } finally {
    process.umask(previousUmask);
  }
}

/** WebSocket paths that belong to features which may be turned off. */
const WEBSOCKET_PATH_FEATURE: Record<string, string> = {
  '/shell': 'shell',
  '/desktop-notifications': 'notifications',
  '/plugin-ws': 'plugins',
  '/ws': 'chat',
};

/**
 * Prepended to the HTTP server's `upgrade` listeners: answers 404 and drops the connection for the WebSocket path of a
 * disabled feature, so the ws server (which then sees a destroyed socket) never opens it.
 */
export function rejectDisabledWebSocketPaths(server: Server, source: CockpitFeatures = features): void {
  server.prependListener('upgrade', (request, socket) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const prefix = pathname.startsWith('/plugin-ws/') ? '/plugin-ws' : pathname;
    const feature = WEBSOCKET_PATH_FEATURE[prefix];
    if (feature && !isFeatureEnabled(feature, source)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    }
  });
}

//----------------- IDLE WATCHDOG ------------------

export type IdleWatchdogOptions = {
  /** Open WebSocket connections of every kind (chat, shell, plugin proxy). */
  getConnectionCount: () => number;
  /** Agent runs that are still working, so closing every tab does not stop a running agent. */
  getActiveRunCount: () => number;
  /** Called once, when the backend has been idle for the whole window. */
  onIdle: () => void;
  /** Idle window in minutes; 0 disables the watchdog. Defaults to AGENT_UI_IDLE_MINUTES or 30. */
  minutes?: number;
  pollMs?: number;
  now?: () => number;
};

/** Exits the backend after `minutes` with no connections and no running agent. Returns controls used by tests. */
export function startIdleWatchdog(options: IdleWatchdogOptions): { stop: () => void; tick: () => void } {
  const minutes = options.minutes ?? Number.parseFloat(process.env.AGENT_UI_IDLE_MINUTES ?? '30');
  const now = options.now ?? Date.now;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { stop: () => undefined, tick: () => undefined };
  }

  const windowMs = minutes * 60_000;
  let idleSince: number | null = now();
  let fired = false;

  const tick = () => {
    if (fired) return;
    if (options.getConnectionCount() > 0 || options.getActiveRunCount() > 0) {
      idleSince = null;
      return;
    }
    idleSince ??= now();
    if (now() - idleSince >= windowMs) {
      fired = true;
      console.log(`[Cockpit] idle for ${minutes} min with no clients and no running agent: exiting`);
      options.onIdle();
    }
  };

  const timer = setInterval(tick, options.pollMs ?? Math.min(15_000, Math.max(1_000, windowMs / 4)));
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}

//----------------- PLATFORM USER ------------------

/**
 * Platform mode (VITE_IS_PLATFORM=true) treats every request as the first user in the DB.
 * Seeds one named after the OS user when the DB is empty; its password is random and never usable.
 */
export function ensurePlatformUser(): void {
  if (userDb.hasUsers()) return;
  const username = os.userInfo().username;
  // Not a valid bcrypt hash on purpose: login by password can never succeed.
  userDb.createUser(username, `!locked!${crypto.randomBytes(32).toString('hex')}`);
  console.log(`[Cockpit] seeded platform user "${username}"`);
}

//----------------- FALLBACK ------------------

/** Mounted after every API route: there is no standalone UI, so unmatched requests (including disabled modules) are 404. */
export function cockpitNotFound(_request: Request, response: Response): void {
  response.status(404).json({ error: 'Not found' });
}
