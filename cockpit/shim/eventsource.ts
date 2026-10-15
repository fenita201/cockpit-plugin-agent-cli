import { isBackendUrl } from './types';

type Fetch = typeof fetch;

/** Incremental parser for the text/event-stream wire format (WHATWG HTML §9.2). */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private eventType = '';
  lastEventId = '';
  retry: number | null = null;
  private skipLf = false;

  constructor(private readonly onEvent: (event: { type: string; data: string; lastEventId: string }) => void) {}

  /** Feed decoded text; complete lines are processed, a partial trailing line is kept for the next chunk. */
  push(text: string): void {
    this.buffer += text;
    let start = 0;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const ch = this.buffer[i];
      if (this.skipLf && i === start) {
        this.skipLf = false;
        if (ch === '\n') { start = i + 1; continue; }
      }
      if (ch === '\n' || ch === '\r') {
        this.line(this.buffer.slice(start, i));
        start = i + 1;
        if (ch === '\r') {
          if (this.buffer[i + 1] === '\n') { i += 1; start = i + 1; } else if (i + 1 >= this.buffer.length) this.skipLf = true;
        }
      }
    }
    this.buffer = this.buffer.slice(start);
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) {
        this.onEvent({ type: this.eventType || 'message', data: this.data.join('\n'), lastEventId: this.lastEventId });
      }
      this.data = [];
      this.eventType = '';
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.eventType = value;
    else if (field === 'id') { if (!value.includes('\0')) this.lastEventId = value; }
    else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
  }
}

/**
 * Builds an `EventSource` replacement. Backend URLs are read through the shimmed `fetch` (so the bytes travel over the
 * Cockpit channel) and parsed as SSE; any other URL gets the browser's real EventSource.
 */
export function createEventSource(shimmedFetch: Fetch, NativeEventSource: typeof EventSource | undefined): typeof EventSource {
  class CockpitEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;

    readonly url!: string;
    readonly withCredentials!: boolean;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    private abort: AbortController | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelay = 3000;
    private lastEventId = '';

    constructor(url: string | URL, init?: EventSourceInit) {
      super();
      if (!isBackendUrl(url) && NativeEventSource) {
        // Not ours: hand back the browser's own implementation (allowed: a constructor may return an object).
        return new NativeEventSource(url, init) as unknown as CockpitEventSource;
      }
      this.url = new URL(url.toString(), globalThis.location?.href ?? 'http://localhost/').toString();
      this.withCredentials = Boolean(init?.withCredentials);
      void this.connect();
    }

    close(): void {
      this.readyState = 2;
      this.abort?.abort();
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    }

    private fire(event: Event, handler: ((event: any) => void) | null): void {
      try { handler?.call(this, event); } catch (error) { console.error(error); }
      this.dispatchEvent(event);
    }

    private async connect(): Promise<void> {
      if (this.readyState === 2) return;
      this.readyState = 0;
      this.abort = new AbortController();
      const headers: Record<string, string> = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
      if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
      try {
        const response = await shimmedFetch(this.url, { headers, signal: this.abort.signal });
        const type = response.headers.get('content-type') ?? '';
        if (response.status !== 200 || !type.includes('text/event-stream') || !response.body) {
          this.fail();
          return;
        }
        this.readyState = 1;
        this.fire(new Event('open'), this.onopen);

        const parser = new SseParser((event) => {
          this.lastEventId = event.lastEventId;
          const message = new MessageEvent(event.type, { data: event.data, lastEventId: event.lastEventId, origin: new URL(this.url).origin });
          this.fire(message, event.type === 'message' ? this.onmessage : null);
        });
        parser.lastEventId = this.lastEventId; // carry the id across reconnects
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
          if (parser.retry !== null) this.reconnectDelay = parser.retry;
          this.lastEventId = parser.lastEventId;
        }
        parser.push(decoder.decode());
        // An `id:` without data still sets the id sent on reconnect (spec: set at every dispatch attempt).
        this.lastEventId = parser.lastEventId;
        this.reconnect();
      } catch {
        if (this.readyState !== 2) this.reconnect();
      }
    }

    // Network-level failure: spec says go back to CONNECTING, emit `error`, and try again.
    private reconnect(): void {
      if (this.readyState === 2) return;
      this.readyState = 0;
      this.fire(new Event('error'), this.onerror);
      this.reconnectTimer = setTimeout(() => void this.connect(), this.reconnectDelay);
    }

    // Wrong status or content type: spec says fail the connection permanently.
    private fail(): void {
      this.readyState = 2;
      this.fire(new Event('error'), this.onerror);
    }
  }

  return CockpitEventSource as unknown as typeof EventSource;
}
