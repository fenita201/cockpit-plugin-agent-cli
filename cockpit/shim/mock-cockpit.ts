// Test helper: a fake `cockpit` whose channels talk to a real unix socket, mimicking Cockpit 360's bridge semantics
// (http-stream2: control `response` before body chunks, then `close`; stream: raw bytes; websocket-stream1: unsupported).
import http from 'node:http';
import net from 'node:net';

import type { CockpitApi, CockpitChannel, CockpitChannelOptions } from './types';

type Listener = (event: unknown, arg?: any) => void;

class FakeChannel implements CockpitChannel {
  private listeners = new Map<string, Listener[]>();
  closed = false;
  private bodyChunks: Uint8Array[] = [];
  private request: http.ClientRequest | null = null;
  private socket: net.Socket | null = null;
  private queued: Uint8Array[] = [];

  constructor(readonly options: CockpitChannelOptions) {
    setImmediate(() => this.start());
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  private emit(type: string, arg?: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener({}, arg);
  }

  private start(): void {
    if (this.closed) return;
    if (this.options.payload === 'http-stream2') return this.startHttp();
    if (this.options.payload === 'stream') return this.startStream();
    this.closeWith({ problem: 'not-supported' });
  }

  private startStream(): void {
    const socket = net.createConnection(String(this.options.unix));
    this.socket = socket;
    socket.on('connect', () => {
      this.emit('ready');
      for (const data of this.queued) socket.write(data);
      this.queued = [];
    });
    socket.on('data', (data) => this.emit('message', new Uint8Array(data)));
    socket.on('end', () => this.closeWith({}));
    socket.on('error', (error: NodeJS.ErrnoException) => this.closeWith({ problem: error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'not-found' : 'terminated', message: error.message }));
  }

  private startHttp(): void {
    // Like the bridge: body is buffered until `done`.
    this.onDone = () => {
      const request = http.request({
        socketPath: String(this.options.unix),
        method: String(this.options.method),
        path: String(this.options.path),
        headers: this.options.headers as http.OutgoingHttpHeaders,
      }, (response) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
        this.emit('control', { command: 'response', status: response.statusCode, reason: response.statusMessage, headers });
        response.on('data', (chunk: Buffer) => this.emit('message', new Uint8Array(chunk)));
        response.on('end', () => this.closeWith({}));
        response.on('error', (error) => this.closeWith({ problem: 'terminated', message: error.message }));
      });
      this.request = request;
      request.on('error', (error: NodeJS.ErrnoException) => this.closeWith({ problem: error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'not-found' : 'terminated', message: error.message }));
      for (const chunk of this.bodyChunks) request.write(chunk);
      request.end();
    };
    if (this.doneBeforeStart) this.onDone();
  }

  private onDone: (() => void) | null = null;
  private doneBeforeStart = false;

  send(data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (this.options.payload === 'http-stream2') this.bodyChunks.push(bytes);
    else if (this.socket?.connecting === false && this.socket.writable) this.socket.write(bytes);
    else this.queued.push(bytes);
  }

  control(options: Record<string, unknown>): void {
    if (options.command === 'done') {
      if (this.onDone) this.onDone();
      else this.doneBeforeStart = true;
    }
  }

  close(problem?: string | Record<string, unknown>): void {
    if (this.closed) return;
    this.request?.destroy();
    this.socket?.destroy();
    this.closeWith(typeof problem === 'string' ? { problem } : (problem ?? {}));
  }

  private closeWith(options: Record<string, unknown>): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', options);
  }
}

export type MockCockpit = CockpitApi & { channels: FakeChannel[] };

/** `channels` records every channel opened, so tests can assert on the options the shims pass. */
export function createMockCockpit(): MockCockpit {
  const channels: FakeChannel[] = [];
  return {
    channels,
    channel(options: CockpitChannelOptions) {
      const channel = new FakeChannel(options);
      channels.push(channel);
      return channel;
    },
  };
}
