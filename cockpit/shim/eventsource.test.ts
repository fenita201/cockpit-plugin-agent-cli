import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createEventSource, SseParser } from './eventsource';
import { createFetch } from './fetch';
import { makeContext, startTestServer, type TestServer } from './test-server';

describe('SseParser', () => {
  const collect = (chunks: string[]) => {
    const events: Array<{ type: string; data: string; lastEventId: string }> = [];
    const parser = new SseParser((e) => events.push(e));
    for (const chunk of chunks) parser.push(chunk);
    return { events, parser };
  };

  it('parses data/event/id, multi-line data and comments', () => {
    const { events } = collect([': comment\nid: 7\nevent: foo\ndata: a\ndata: b\n\ndata: c\n\n']);
    expect(events).toEqual([
      { type: 'foo', data: 'a\nb', lastEventId: '7' },
      { type: 'message', data: 'c', lastEventId: '7' },
    ]);
  });

  it('handles CRLF, lone CR and chunks split anywhere (even between CR and LF)', () => {
    const text = 'data: x\r\n\r\ndata: y\r\rdata: z\n\n';
    for (let cut = 1; cut < text.length; cut += 1) {
      const { events } = collect([text.slice(0, cut), text.slice(cut)]);
      expect(events.map((e) => e.data)).toEqual(['x', 'y', 'z']);
    }
  });

  it('ignores an event with no data, strips one leading space, records retry', () => {
    const { events, parser } = collect(['event: empty\n\ndata:  two spaces\nretry: 1500\n\n']);
    expect(events).toEqual([{ type: 'message', data: ' two spaces', lastEventId: '' }]);
    expect(parser.retry).toBe(1500);
  });
});

describe('CockpitEventSource', () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(async () => { await server.close(); });

  const setup = () => {
    const ctx = makeContext(server.socket);
    const shimmed = createFetch(ctx, vi.fn() as unknown as typeof fetch);
    const NativeES = vi.fn(function Native() { return { native: true }; }) as unknown as typeof EventSource;
    return { ES: createEventSource(shimmed, NativeES), NativeES };
  };

  it('open, typed + default messages, then error/reconnect with Last-Event-ID', async () => {
    const { ES } = setup();
    const es = new ES('http://localhost/api/sse');
    const seen: string[] = [];
    es.addEventListener('hello', (e) => seen.push(`hello:${(e as MessageEvent).data}`));
    es.onmessage = (e) => seen.push(`msg:${e.data}`);
    const opened = new Promise<void>((resolve) => { es.onopen = () => resolve(); });
    await opened;
    await vi.waitFor(() => expect(seen).toEqual(['hello:one', 'msg:two\nlines']));
    await vi.waitFor(() => expect(es.readyState).toBe(0)); // stream ended: reconnecting
    es.close();
    expect(es.readyState).toBe(2);
  });

  it('a non-event-stream response fails permanently', async () => {
    const { ES } = setup();
    const es = new ES('http://localhost/api/not-sse');
    await new Promise<void>((resolve) => { es.onerror = () => resolve(); });
    expect(es.readyState).toBe(2);
  });

  it('non-backend URLs get the native EventSource', () => {
    const { ES, NativeES } = setup();
    const es = new ES('http://localhost/other/stream') as unknown as { native: boolean };
    expect(es.native).toBe(true);
    expect(NativeES).toHaveBeenCalled();
  });
});
