// Test helper: real HTTP + WebSocket (`ws`) server on a unix socket, plus a ShimContext wired to the mock cockpit.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

import { createMockCockpit, type MockCockpit } from './mock-cockpit';
import type { ShimContext } from './types';

export type TestServer = {
  socket: string;
  http: http.Server;
  wss: WebSocketServer;
  sockets: Set<ServerSocket>;
  close: () => Promise<void>;
};

export async function startTestServer(socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aui-shim-')), 's.sock')): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const route = url.pathname.replace(/^\/api/, '');
    if (route === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('id: 1\nevent: hello\ndata: one\n\n');
      const timer = setTimeout(() => { res.write('data: two\ndata: lines\n\n'); res.end(); }, 80);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (route === '/slow') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('first');
      return; // never ends: used for abort tests
    }
    if (route === '/status') {
      const code = Number(url.searchParams.get('code'));
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(code === 204 ? undefined : JSON.stringify({ error: `code ${code}` }));
      return;
    }
    if (route === '/not-sse') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('nope');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Test': 'yes' });
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'] ?? null,
        body: Buffer.concat(chunks).toString('latin1'),
        bodyLength: Buffer.concat(chunks).length,
      }));
    });
  });
  const wss = new WebSocketServer({ server });
  const sockets = new Set<ServerSocket>();
  wss.on('connection', (ws, request) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
    if (request.url?.includes('greet')) ws.send('hello');
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return {
    socket, http: server, wss, sockets,
    close: () => new Promise<void>((resolve) => {
      for (const client of wss.clients) client.terminate();
      server.closeAllConnections();
      wss.close(() => server.close(() => { fs.rmSync(path.dirname(socket), { recursive: true, force: true }); resolve(); }));
    }),
  };
}

export function makeContext(socket: string, ensure?: () => Promise<string>): ShimContext & { cockpit: MockCockpit; ensureCalls: number } {
  const cockpit = createMockCockpit();
  const ctx = {
    cockpit,
    ensureCalls: 0,
    socketPath: () => socket,
    ensure: async () => { ctx.ensureCalls += 1; return ensure ? ensure() : socket; },
  };
  return ctx;
}
