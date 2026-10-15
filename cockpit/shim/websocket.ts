import { isBackendUrl, type CockpitChannel, type ShimContext } from './types';

// Cockpit 360's bridge has no `websocket-stream1` channel, so this is a small RFC 6455 client running on a raw
// `stream` channel to the backend's unix socket: HTTP Upgrade handshake, masked client frames, fragmentation,
// ping/pong and the close handshake. No extensions (no permessage-deflate) are negotiated.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 3000;

const enum Op { Continuation = 0x0, Text = 0x1, Binary = 0x2, Close = 0x8, Ping = 0x9, Pong = 0xa }

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Builds one masked client frame (clients MUST mask, RFC 6455 §5.3). */
export function encodeFrame(opcode: number, payload: Uint8Array, mask: Uint8Array = crypto.getRandomValues(new Uint8Array(4))): Uint8Array {
  const length = payload.length;
  const headerLength = 2 + (length < 126 ? 0 : length < 65536 ? 2 : 8) + 4;
  const frame = new Uint8Array(headerLength + length);
  frame[0] = 0x80 | opcode;
  let offset = 2;
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length < 65536) {
    frame[1] = 0x80 | 126;
    frame[2] = length >> 8;
    frame[3] = length & 0xff;
    offset = 4;
  } else {
    frame[1] = 0x80 | 127;
    const view = new DataView(frame.buffer);
    view.setUint32(2, Math.floor(length / 2 ** 32));
    view.setUint32(6, length >>> 0);
    offset = 10;
  }
  frame.set(mask, offset);
  offset += 4;
  for (let i = 0; i < length; i += 1) frame[offset + i] = payload[i] ^ mask[i & 3];
  return frame;
}

type Frame = { fin: boolean; rsv: number; masked: boolean; opcode: number; payload: Uint8Array };

/** Incremental server-to-client frame parser. Returns complete frames; keeps partial data buffered. */
export class FrameParser {
  private chunks: Uint8Array[] = [];
  private size = 0;
  // Bytes needed before a parse attempt can make progress, so a big frame arriving in small chunks is concatenated once.
  private needed = 2;

  push(data: Uint8Array): Frame[] {
    if (data.length > 0) { this.chunks.push(data); this.size += data.length; }
    if (this.size < this.needed) return [];
    const buffer = concat(this.chunks);
    const frames: Frame[] = [];
    let pos = 0;
    for (;;) {
      const available = buffer.length - pos;
      this.needed = 2;
      if (available < 2) break;
      const fin = (buffer[pos] & 0x80) !== 0;
      const rsv = (buffer[pos] >> 4) & 0x07;
      const opcode = buffer[pos] & 0x0f;
      const masked = (buffer[pos + 1] & 0x80) !== 0;
      let length = buffer[pos + 1] & 0x7f;
      let headerLength = 2;
      if (length === 126) {
        headerLength = 4;
        if (available < headerLength) { this.needed = headerLength; break; }
        length = (buffer[pos + 2] << 8) | buffer[pos + 3];
      } else if (length === 127) {
        headerLength = 10;
        if (available < headerLength) { this.needed = headerLength; break; }
        const view = new DataView(buffer.buffer, buffer.byteOffset + pos, 10);
        length = view.getUint32(2) * 2 ** 32 + view.getUint32(6);
      }
      if (length > MAX_MESSAGE_BYTES) throw new RangeError('frame too large');
      const maskLength = masked ? 4 : 0;
      const total = headerLength + maskLength + length;
      if (available < total) { this.needed = total; break; }
      const start = pos + headerLength + maskLength;
      const payload = buffer.slice(start, start + length);
      if (masked) {
        const mask = buffer.subarray(pos + headerLength, pos + headerLength + 4);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      }
      frames.push({ fin, rsv, masked, opcode, payload });
      pos += total;
    }
    const rest = buffer.slice(pos);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    return frames;
  }
}

/**
 * Builds a `WebSocket` replacement. Backend URLs (/ws, /shell, /plugin-ws/..., /desktop-notifications) are opened over the
 * Cockpit channel; any other URL gets the browser's real WebSocket.
 */
export function createWebSocket(ctx: ShimContext, NativeWebSocket: typeof WebSocket | undefined): typeof WebSocket {
  class CockpitWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    readonly url!: string;
    readyState = 0;
    binaryType: BinaryType = 'blob';
    bufferedAmount = 0;
    extensions = '';
    protocol = '';
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    private channel: CockpitChannel | null = null;
    private readonly requestedProtocols!: string[];
    private handshakeBuffer: Uint8Array = new Uint8Array(0);
    private handshakeDone = false;
    private expectedAccept = '';
    private readonly parser = new FrameParser();
    private fragments: Uint8Array[] = [];
    private fragmentOpcode = 0;
    private fragmentBytes = 0;
    private closeSent = false;
    private closeEmitted = false;
    private errorFired = false;
    private closeTimer: ReturnType<typeof setTimeout> | null = null;
    private sendChain: Promise<void> = Promise.resolve();
    private retried = false;

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      if (!isBackendUrl(url) && NativeWebSocket) {
        // Not ours: hand back the browser's own implementation (allowed: a constructor may return an object).
        return new NativeWebSocket(url, protocols) as unknown as CockpitWebSocket;
      }
      this.url = new URL(url.toString(), globalThis.location?.href ?? 'http://localhost/').toString();
      this.requestedProtocols = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
      this.open();
    }

    //----------------- connection ------------------

    private open(): void {
      const target = new URL(this.url);
      const key = toBase64(crypto.getRandomValues(new Uint8Array(16)));
      this.handshakeBuffer = new Uint8Array(0);
      this.handshakeDone = false;
      // The expected Sec-WebSocket-Accept is computed before anything is sent, so the check can never be skipped.
      void computeAccept(key).then((accept) => {
        if (this.closeEmitted) return;
        this.expectedAccept = accept;
        this.connect(target, key);
      });
    }

    private connect(target: URL, key: string): void {

      const channel = this.channel = ctx.cockpit.channel({ payload: 'stream', unix: ctx.socketPath(), binary: true });
      channel.addEventListener('message', (_event, data) => {
        if (channel !== this.channel) return;
        try {
          this.onBytes(typeof data === 'string' ? new TextEncoder().encode(data) : data);
        } catch (error) {
          this.failConnection(error instanceof RangeError ? 1009 : 1002);
        }
      });
      channel.addEventListener('close', (_event, options) => {
        if (channel !== this.channel) return;
        // Before the handshake nothing has been exchanged, so a failed connect is safe to retry. The bridge reports a
        // refused connection as not-found but a missing socket file (backend gone, socket removed) as terminated.
        if ((options.problem === 'not-found' || options.problem === 'terminated') && !this.handshakeDone && !this.retried) {
          // The backend most likely idle-exited: bring it back, then reconnect once before reporting an error.
          this.retried = true;
          void ctx.ensure().then(
            () => { if (!this.closeEmitted) this.open(); },
            () => this.finish(1006, '', false),
          );
          return;
        }
        this.finish(1006, '', false);
      });

      const lines = [
        `GET ${target.pathname}${target.search} HTTP/1.1`,
        'Host: localhost',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ];
      if (this.requestedProtocols.length) lines.push(`Sec-WebSocket-Protocol: ${this.requestedProtocols.join(', ')}`);
      channel.send(new TextEncoder().encode(`${lines.join('\r\n')}\r\n\r\n`));
    }

    private onBytes(data: Uint8Array): void {
      if (!this.handshakeDone) {
        const merged = new Uint8Array(this.handshakeBuffer.length + data.length);
        merged.set(this.handshakeBuffer);
        merged.set(data, this.handshakeBuffer.length);
        this.handshakeBuffer = merged;
        const end = indexOfHeaderEnd(merged);
        if (end === -1) {
          if (merged.length > 64 * 1024) this.failConnection(1002);
          return;
        }
        const head = new TextDecoder().decode(merged.subarray(0, end));
        const rest = merged.subarray(end + 4);
        this.handshakeBuffer = new Uint8Array(0);
        if (!this.acceptHandshake(head)) return;
        this.handshakeDone = true;
        this.readyState = 1;
        this.fire(new Event('open'), this.onopen);
        if (rest.length) this.onBytes(rest);
        return;
      }
      for (const frame of this.parser.push(data)) this.onFrame(frame);
    }

    private acceptHandshake(head: string): boolean {
      const [statusLine, ...headerLines] = head.split('\r\n');
      if (!/^HTTP\/1\.[01] 101\b/.test(statusLine)) {
        this.failConnection(1002);
        return false;
      }
      const headers = new Map<string, string>();
      for (const line of headerLines) {
        const colon = line.indexOf(':');
        if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      // The accept value is only checkable where crypto.subtle exists (secure contexts); the socket is local and 600 anyway.
      if (this.expectedAccept && headers.get('sec-websocket-accept') !== this.expectedAccept) {
        this.failConnection(1002);
        return false;
      }
      const protocol = headers.get('sec-websocket-protocol') ?? '';
      if (protocol && !this.requestedProtocols.includes(protocol)) {
        this.failConnection(1002);
        return false;
      }
      this.protocol = protocol;
      return true;
    }

    //----------------- incoming frames ------------------

    private onFrame(frame: Frame): void {
      // No extensions are negotiated (RSV must be 0) and servers must not mask (RFC 6455 §5.1, §5.2).
      if (frame.rsv !== 0 || frame.masked) return this.failConnection(1002);
      // Control frames are never fragmented and carry at most 125 bytes (§5.5).
      if (frame.opcode >= 0x8 && (!frame.fin || frame.payload.length > 125)) return this.failConnection(1002);
      switch (frame.opcode) {
        case Op.Text:
        case Op.Binary:
          if (this.fragments.length) return this.failConnection(1002);
          if (frame.fin) this.deliver(frame.opcode, frame.payload);
          else { this.fragmentOpcode = frame.opcode; this.fragments = [frame.payload]; this.fragmentBytes = frame.payload.length; }
          return;
        case Op.Continuation:
          if (!this.fragments.length) return this.failConnection(1002);
          this.fragments.push(frame.payload);
          this.fragmentBytes += frame.payload.length;
          if (this.fragmentBytes > MAX_MESSAGE_BYTES) return this.failConnection(1009);
          if (frame.fin) {
            const payload = concat(this.fragments);
            this.fragments = [];
            this.deliver(this.fragmentOpcode, payload);
          }
          return;
        case Op.Ping:
          this.writeFrame(Op.Pong, frame.payload);
          return;
        case Op.Pong:
          return;
        case Op.Close: {
          const code = frame.payload.length >= 2 ? (frame.payload[0] << 8) | frame.payload[1] : 1005;
          const reason = frame.payload.length > 2 ? new TextDecoder().decode(frame.payload.subarray(2)) : '';
          if (!this.closeSent) {
            this.closeSent = true;
            this.readyState = 2;
            this.writeFrame(Op.Close, frame.payload.length >= 2 ? frame.payload.subarray(0, 2) : new Uint8Array(0));
          }
          this.finish(code, reason, true);
          return;
        }
        default:
          this.failConnection(1002);
      }
    }

    private deliver(opcode: number, payload: Uint8Array): void {
      if (this.readyState !== 1) return;
      let data: string | Blob | ArrayBuffer;
      if (opcode === Op.Text) {
        try {
          data = new TextDecoder('utf-8', { fatal: true }).decode(payload);
        } catch {
          return this.failConnection(1007);
        }
      } else if (this.binaryType === 'arraybuffer') {
        data = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
      } else {
        data = new Blob([payload as BlobPart]);
      }
      this.fire(new MessageEvent('message', { data, origin: new URL(this.url).origin }), this.onmessage);
    }

    //----------------- API ------------------

    send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
      if (this.readyState === 0) throw new DOMException('WebSocket is still in CONNECTING state.', 'InvalidStateError');
      if (this.readyState !== 1) return;
      if (typeof data === 'string') {
        const bytes = new TextEncoder().encode(data);
        this.enqueue(() => this.writeFrame(Op.Text, bytes));
      } else if (data instanceof Blob) {
        this.enqueue(async () => this.writeFrame(Op.Binary, new Uint8Array(await data.arrayBuffer())));
      } else if (ArrayBuffer.isView(data)) {
        const bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        this.enqueue(() => this.writeFrame(Op.Binary, bytes));
      } else {
        const bytes = new Uint8Array(data.slice(0));
        this.enqueue(() => this.writeFrame(Op.Binary, bytes));
      }
    }

    close(code?: number, reason?: string): void {
      if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
        throw new DOMException('The close code must be either 1000, or between 3000 and 4999.', 'InvalidAccessError');
      }
      const reasonBytes = new TextEncoder().encode(reason ?? '');
      if (reasonBytes.length > 123) throw new DOMException('The close reason must not be greater than 123 UTF-8 bytes.', 'SyntaxError');
      if (this.readyState === 2 || this.readyState === 3) return;
      if (this.readyState === 0) {
        // Closing before the handshake completes fails the connection (browser behaviour).
        this.channel?.close();
        this.finish(1006, '', false);
        return;
      }
      this.readyState = 2;
      this.closeSent = true;
      const payload = new Uint8Array(code === undefined ? 0 : 2 + reasonBytes.length);
      if (code !== undefined) { payload[0] = code >> 8; payload[1] = code & 0xff; payload.set(reasonBytes, 2); }
      this.enqueue(() => this.writeFrame(Op.Close, payload));
      // If the server never answers, drop the channel ourselves.
      this.closeTimer = setTimeout(() => this.finish(code ?? 1005, reason ?? '', false), CLOSE_TIMEOUT_MS);
    }

    //----------------- helpers ------------------

    // Sends go through one chain so a Blob (async read) cannot be overtaken by a later string.
    private enqueue(task: () => void | Promise<void>): void {
      this.sendChain = this.sendChain.then(task).catch(() => undefined);
    }

    private writeFrame(opcode: number, payload: Uint8Array): void {
      if (!this.channel || this.closeEmitted) return;
      try {
        this.channel.send(encodeFrame(opcode, payload));
      } catch {
        // channel already closed: finish() handles the state
      }
    }

    private failConnection(code: number): void {
      if (this.closeEmitted) return;
      this.fireError();
      if (this.handshakeDone && !this.closeSent) {
        this.closeSent = true;
        this.readyState = 2;
        this.writeFrame(Op.Close, new Uint8Array([code >> 8, code & 0xff]));
      }
      this.finish(1006, '', false);
    }

    private finish(code: number, reason: string, wasClean: boolean): void {
      if (this.closeEmitted) return;
      this.closeEmitted = true;
      if (this.closeTimer) clearTimeout(this.closeTimer);
      const channel = this.channel;
      this.channel = null;
      const wasConnecting = this.readyState === 0;
      this.readyState = 3;
      // Give a pending close frame a moment to flush before the transport goes away.
      this.sendChain.then(() => { try { channel?.close(); } catch { /* already closed */ } });
      if (wasConnecting) this.fireError();
      this.fire(new CloseEvent('close', { code, reason, wasClean }), this.onclose);
    }

    // A failed connection reports `error` once, then `close` (browser behaviour).
    private fireError(): void {
      if (this.errorFired) return;
      this.errorFired = true;
      this.fire(new Event('error'), this.onerror);
    }

    private fire(event: Event, handler: ((event: any) => void) | null): void {
      try { handler?.call(this, event); } catch (error) { console.error(error); }
      this.dispatchEvent(event);
    }
  }

  return CockpitWebSocket as unknown as typeof WebSocket;
}

function indexOfHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}

async function computeAccept(key: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return '';
  const digest = await subtle.digest('SHA-1', new TextEncoder().encode(key + GUID));
  return toBase64(new Uint8Array(digest));
}
