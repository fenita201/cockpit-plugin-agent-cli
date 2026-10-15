import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createWebSocket, encodeFrame, FrameParser } from './websocket';
import { makeContext, startTestServer, type TestServer } from './test-server';

let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { await server.close(); });

const url = (p = '/ws') => `ws://localhost${p}`;

function setup(socket = server.socket, ensure?: () => Promise<string>) {
  const ctx = makeContext(socket, ensure);
  const NativeWS = vi.fn(function Native() { return { native: true }; }) as unknown as typeof WebSocket;
  return { ctx, WS: createWebSocket(ctx, NativeWS), NativeWS };
}

const opened = (ws: WebSocket) => new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('error before open')); });
const nextMessage = (ws: WebSocket) => new Promise<MessageEvent>((resolve) => { ws.onmessage = resolve; });
const closed = (ws: WebSocket) => new Promise<CloseEvent>((resolve) => { ws.onclose = resolve; });

describe('FrameParser / encodeFrame', () => {
  it('round-trips masked frames of 0, 125, 126 and 70000 bytes fed one byte at a time', () => {
    for (const size of [0, 125, 126, 70000]) {
      const payload = new Uint8Array(size).map((_, i) => i % 251);
      const frame = encodeFrame(2, payload, new Uint8Array([1, 2, 3, 4]));
      const parser = new FrameParser();
      const frames = [];
      const step = size > 1000 ? 997 : 1;
      for (let i = 0; i < frame.length; i += step) frames.push(...parser.push(frame.subarray(i, i + step)));
      expect(frames).toHaveLength(1);
      expect(frames[0].opcode).toBe(2);
      expect(frames[0].payload).toEqual(payload);
    }
  });

  it('parses several frames from a single chunk', () => {
    const a = encodeFrame(1, new TextEncoder().encode('a'));
    const b = encodeFrame(1, new TextEncoder().encode('b'));
    const both = new Uint8Array(a.length + b.length);
    both.set(a); both.set(b, a.length);
    expect(new FrameParser().push(both).map((f) => new TextDecoder().decode(f.payload))).toEqual(['a', 'b']);
  });
});

describe('CockpitWebSocket', () => {
  it('handshake: opens, exposes the standard constants, and echoes text', async () => {
    const { WS } = setup();
    const ws = new WS(url());
    expect(ws.readyState).toBe(0);
    expect(WS.OPEN).toBe(1);
    await opened(ws);
    expect(ws.readyState).toBe(1);
    const message = nextMessage(ws);
    ws.send('héllo ✓');
    expect((await message).data).toBe('héllo ✓');
    ws.close(1000);
    expect((await closed(ws)).code).toBe(1000);
    expect(ws.readyState).toBe(3);
  });

  it('send() while CONNECTING throws InvalidStateError', () => {
    const { WS } = setup();
    const ws = new WS(url());
    expect(() => ws.send('x')).toThrowError(expect.objectContaining({ name: 'InvalidStateError' }));
    ws.close();
  });

  it('text messages of 125 / 126 / 65536 / 200000 bytes round-trip', async () => {
    const { WS } = setup();
    const ws = new WS(url());
    await opened(ws);
    for (const size of [125, 126, 65536, 200000]) {
      const text = 'x'.repeat(size);
      const message = nextMessage(ws);
      ws.send(text);
      expect(((await message).data as string).length).toBe(size);
    }
    ws.close();
    await closed(ws);
  });

  it('binary: arraybuffer and blob binaryType, ArrayBufferView and Blob inputs', async () => {
    const { WS } = setup();
    const ws = new WS(url());
    ws.binaryType = 'arraybuffer';
    await opened(ws);
    let message = nextMessage(ws);
    ws.send(new Uint8Array([1, 2, 3, 250]));
    expect(new Uint8Array((await message).data as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3, 250]));
    message = nextMessage(ws);
    ws.send(new Blob([new Uint8Array([9, 8])]));
    expect(new Uint8Array((await message).data as ArrayBuffer)).toEqual(new Uint8Array([9, 8]));
    ws.binaryType = 'blob';
    message = nextMessage(ws);
    ws.send(new Uint8Array([7]));
    const blob = (await message).data as Blob;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([7]));
    ws.close();
    await closed(ws);
  });

  it('messages sent in order, even when a Blob precedes strings', async () => {
    const { WS } = setup();
    const ws = new WS(url());
    await opened(ws);
    const got: unknown[] = [];
    ws.onmessage = (e) => got.push(typeof e.data === 'string' ? e.data : 'bin');
    ws.send(new Blob(['b']));
    ws.send('s1');
    ws.send('s2');
    await vi.waitFor(() => expect(got).toEqual(['bin', 's1', 's2']));
    ws.close();
    await closed(ws);
  });

  it('data sent by the server immediately after the upgrade is not lost', async () => {
    const { WS } = setup();
    const ws = new WS(url('/ws?greet=1'));
    const message = nextMessage(ws);
    await opened(ws);
    expect((await message).data).toBe('hello');
    ws.close();
    await closed(ws);
  });

  it('answers server pings and reassembles fragmented messages', async () => {
    const { WS } = setup();
    const ws = new WS(url());
    await opened(ws);
    const serverSide = [...server.sockets].at(-1)!;
    const pong = new Promise<Buffer>((resolve) => serverSide.once('pong', resolve));
    serverSide.ping(Buffer.from('pp'));
    expect((await pong).toString()).toBe('pp');

    const message = nextMessage(ws);
    // ws lets us send a fragmented message with the multi-byte char split across fragments
    const bytes = new TextEncoder().encode('日本語');
    serverSide.send(Buffer.from(bytes.subarray(0, 4)), { binary: false, fin: false });
    serverSide.send(Buffer.from(bytes.subarray(4)), { binary: false, fin: true } as never);
    expect((await message).data).toBe('日本語');
    ws.close();
    await closed(ws);
  });

  it('server-initiated close delivers code/reason, wasClean, and CLOSED state', async () => {
    const { WS } = setup();
    const ws = new WS(url());
    await opened(ws);
    const done = closed(ws);
    [...server.sockets].at(-1)!.close(4001, 'bye');
    const event = await done;
    expect(event).toMatchObject({ code: 4001, reason: 'bye', wasClean: true });
    expect(ws.readyState).toBe(3);
  });

  it('server dying mid-connection ends with 1006 / wasClean=false', async () => {
    const { WS } = setup();
    const ws = new WS(url());
    await opened(ws);
    const done = closed(ws);
    for (const client of server.wss.clients) client.terminate();
    const event = await done;
    expect(event.code).toBe(1006);
    expect(event.wasClean).toBe(false);
  });

  it('validates close() arguments', async () => {
    const { WS } = setup();
    const ws = new WS(url());
    await opened(ws);
    expect(() => ws.close(1234)).toThrowError(expect.objectContaining({ name: 'InvalidAccessError' }));
    expect(() => ws.close(1000, 'x'.repeat(124))).toThrowError(expect.objectContaining({ name: 'SyntaxError' }));
    ws.close(1000);
    await closed(ws);
  });

  it('addEventListener works alongside on* handlers', async () => {
    const { WS } = setup();
    const ws = new WS(url());
    const events: string[] = [];
    ws.addEventListener('open', () => events.push('open'));
    ws.addEventListener('close', () => events.push('close'));
    await opened(ws);
    ws.close();
    await closed(ws);
    expect(events).toEqual(['open', 'close']);
  });

  it('backend down at connect: runs ensure() then connects transparently', async () => {
    const missing = server.socket.replace('s.sock', 'missing.sock');
    const { WS, ctx } = setup(missing, async () => { ctx.socketPath = () => server.socket; return server.socket; });
    const ws = new WS(url());
    await opened(ws);
    expect(ctx.ensureCalls).toBe(1);
    ws.close();
    await closed(ws);
  });

  it('backend still down after ensure(): error then close 1006', async () => {
    const missing = server.socket.replace('s.sock', 'missing.sock');
    const { WS } = setup(missing);
    const ws = new WS(url());
    const events: string[] = [];
    ws.onerror = () => events.push('error');
    const event = await new Promise<CloseEvent>((resolve) => { ws.onclose = resolve; });
    expect(events).toEqual(['error']);
    expect(event.code).toBe(1006);
  });

  it('non-backend URLs get the native WebSocket', () => {
    const { WS, NativeWS } = setup();
    expect((new WS('wss://example.com/socket') as unknown as { native: boolean }).native).toBe(true);
    expect((new WS('ws://localhost/other') as unknown as { native: boolean }).native).toBe(true);
    expect(NativeWS).toHaveBeenCalledTimes(2);
  });

  it('routes /shell and /plugin-ws/x through the channel', async () => {
    const { WS, ctx } = setup();
    for (const p of ['/shell', '/plugin-ws/claude-usage']) {
      const ws = new WS(url(p));
      await opened(ws);
      ws.close();
      await closed(ws);
    }
    expect(ctx.cockpit.channels.filter((c) => c.options.payload === 'stream')).toHaveLength(2);
  });
});

describe('CockpitWebSocket regressions (review findings)', () => {
  it('close() while the ensure-and-retry is pending never opens a zombie connection', async () => {
    const missing = server.socket.replace('s.sock', 'missing.sock');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { WS, ctx } = setup(missing, async () => { await gate; ctx.socketPath = () => server.socket; return server.socket; });
    const ws = new WS(url());
    const events: string[] = [];
    ws.onopen = () => events.push('open');
    ws.onclose = () => events.push('close');
    await vi.waitFor(() => expect(ctx.ensureCalls).toBe(1));
    ws.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toEqual(['close']);
    expect(ws.readyState).toBe(3);
    expect(ctx.cockpit.channels.filter((c) => c.options.unix === server.socket)).toHaveLength(0);
  });

  it('a failed handshake reports error exactly once, then close', async () => {
    const net = await import('node:net');
    const fs = await import('node:fs');
    const sock = server.socket.replace('s.sock', 'bad-handshake.sock');
    const raw = net.createServer((c) => c.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'));
    await new Promise<void>((resolve) => raw.listen(sock, resolve));
    try {
      const { WS } = setup(sock);
      const ws = new WS(url());
      const events: string[] = [];
      ws.onerror = () => events.push('error');
      const done = new Promise<CloseEvent>((resolve) => { ws.onclose = resolve; });
      expect((await done).code).toBe(1006);
      expect(events).toEqual(['error']);
    } finally {
      raw.close();
      fs.rmSync(sock, { force: true });
    }
  });

  it('protocol violations from the server (RSV bits, masked frames, long control frames) fail the connection', async () => {
    const net = await import('node:net');
    const fs = await import('node:fs');
    const crypto = await import('node:crypto');
    for (const bad of [Buffer.from([0xc1, 0x01, 0x41]), Buffer.from([0x81, 0x81, 1, 2, 3, 4, 0x41]), Buffer.concat([Buffer.from([0x89, 126, 0, 200]), Buffer.alloc(200)])]) {
      const sock = server.socket.replace('s.sock', `bad-frame-${bad[0]}-${bad[1]}.sock`);
      const raw = net.createServer((c) => {
        c.on('error', () => {});
        let head = '';
        c.on('data', (d) => {
          head += d.toString('latin1');
          if (!head.includes('\r\n\r\n')) return;
          const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(head)![1];
          const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
          c.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
          c.write(bad);
        });
      });
      await new Promise<void>((resolve) => raw.listen(sock, resolve));
      try {
        const { WS } = setup(sock);
        const ws = new WS(url());
        const got: string[] = [];
        ws.onopen = () => got.push('open');
        ws.onmessage = () => got.push('message');
        ws.onerror = () => got.push('error');
        const event = await new Promise<CloseEvent>((resolve) => { ws.onclose = resolve; });
        expect(event.code).toBe(1006);
        expect(got).toEqual(['open', 'error']);
      } finally {
        raw.close();
        fs.rmSync(sock, { force: true });
      }
    }
  });
});
