import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createFetch } from './fetch';
import { makeContext, startTestServer, type TestServer } from './test-server';

let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { await server.close(); });

const native = () => vi.fn(async () => new Response('native')) as unknown as typeof fetch;

describe('createFetch', () => {
  it('GET goes through the channel with binary + unix options', async () => {
    const ctx = makeContext(server.socket);
    const f = createFetch(ctx, native());
    const res = await f('http://localhost/api/things?a=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-test')).toBe('yes');
    const json = await res.json();
    expect(json).toMatchObject({ method: 'GET', url: '/api/things?a=1' });
    expect(ctx.cockpit.channels[0].options).toMatchObject({ payload: 'http-stream2', unix: server.socket, binary: true, method: 'GET', path: '/api/things?a=1' });
  });

  it('POST JSON sends the body and content-type', async () => {
    const f = createFetch(makeContext(server.socket), native());
    const res = await f('http://localhost/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 1 }) });
    expect(await res.json()).toMatchObject({ method: 'POST', contentType: 'application/json', body: '{"a":1}' });
  });

  it('does not forward host/content-length/accept-encoding from the Request', async () => {
    const ctx = makeContext(server.socket);
    await createFetch(ctx, native())('http://localhost/api/x', { method: 'POST', body: 'abc', headers: { 'accept-encoding': 'gzip' } });
    const headers = ctx.cockpit.channels[0].options.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-length');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('accept-encoding');
  });

  it('FormData keeps its multipart boundary and bytes (binary-safe)', async () => {
    const f = createFetch(makeContext(server.socket), native());
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([0, 1, 2, 255, 254])], { type: 'application/octet-stream' }), 'a.bin');
    form.append('note', 'hi');
    const json = await (await f('http://localhost/api/assets/files', { method: 'POST', body: form })).json();
    expect(json.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(json.body).toContain('filename="a.bin"');
    expect(json.body).toContain('\u0000\u0001\u0002ÿþ');
  });

  it('keeps the body of 4xx/5xx responses and does not reject', async () => {
    const f = createFetch(makeContext(server.socket), native());
    const res = await f('http://localhost/api/status?code=500');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'code 500' });
    expect((await f('http://localhost/api/status?code=404')).status).toBe(404);
  });

  it('handles 204 and HEAD (no body)', async () => {
    const f = createFetch(makeContext(server.socket), native());
    const res = await f('http://localhost/api/status?code=204');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect((await f('http://localhost/api/x', { method: 'HEAD' })).status).toBe(200);
  });

  it('streams the response: first chunk is readable before the response ends', async () => {
    const f = createFetch(makeContext(server.socket), native());
    const res = await f('http://localhost/api/slow');
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('first');
    await reader.cancel();
  });

  it('abort while streaming errors the stream; abort before start rejects', async () => {
    const f = createFetch(makeContext(server.socket), native());
    const controller = new AbortController();
    const res = await f('http://localhost/api/slow', { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });

    const pre = new AbortController();
    pre.abort();
    await expect(f('http://localhost/api/x', { signal: pre.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('non-backend URLs use the native fetch', async () => {
    const nativeFetch = native();
    const f = createFetch(makeContext(server.socket), nativeFetch);
    expect(await (await f('http://localhost/assets/logo.svg')).text()).toBe('native');
    expect(await (await f('https://example.com/api/x')).text()).toBe('native');
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  it('backend down: calls ensure() once and retries (also for POST)', async () => {
    const missing = server.socket.replace('s.sock', 'missing.sock');
    const ctx = makeContext(missing, async () => { ctx.socketPath = () => server.socket; return server.socket; });
    const f = createFetch(ctx, native());
    const res = await f('http://localhost/api/x', { method: 'POST', body: 'payload' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ body: 'payload' });
    expect(ctx.ensureCalls).toBe(1);
  });

  it('backend still down after ensure: rejects with TypeError', async () => {
    const missing = server.socket.replace('s.sock', 'missing.sock');
    const ctx = makeContext(missing);
    await expect(createFetch(ctx, native())('http://localhost/api/x')).rejects.toBeInstanceOf(TypeError);
    expect(ctx.ensureCalls).toBe(1);
  });
});

describe('createFetch regressions (review findings)', () => {
  it('a non-backend Request with a body reaches the native fetch with its body intact', async () => {
    let seen = '';
    const nativeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = await new Request(input, init).text();
      return new Response('ok');
    }) as typeof fetch;
    const f = createFetch(makeContext(server.socket), nativeFetch);
    await f(new Request('https://example.com/upload', { method: 'POST', body: 'payload' }));
    expect(seen).toBe('payload');
  });

  it('an abort while ensure() is running is honoured, with the signal reason', async () => {
    const missing = server.socket.replace('s.sock', 'missing.sock');
    const controller = new AbortController();
    const ctx = makeContext(missing, async () => { controller.abort(new DOMException('too slow', 'TimeoutError')); return server.socket; });
    const f = createFetch(ctx, native());
    await expect(f('http://localhost/api/x', { signal: controller.signal })).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
