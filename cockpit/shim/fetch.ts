import { isBackendUrl, type CockpitChannel, type ShimContext } from './types';

const DROPPED_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding']);
// Response statuses that must not carry a body in the Response constructor.
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Builds a `fetch` replacement that sends backend URLs (/api, /health, ...) through a Cockpit
 * `http-stream2` channel to the backend's unix socket, and everything else to `nativeFetch`.
 * Responses stream: SSE and chunked bodies arrive chunk by chunk, and non-2xx responses keep their body.
 */
export function createFetch(ctx: ShimContext, nativeFetch: typeof fetch): typeof fetch {
  return async function cockpitFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    if (!isBackendUrl(request.url)) return nativeFetch(input, init);

    const url = new URL(request.url);
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      if (!DROPPED_REQUEST_HEADERS.has(key.toLowerCase())) headers[key] = value;
    });
    const signal = request.signal;
    if (signal.aborted) throw abortError();

    const attempt = (): Promise<Response | 'retry'> =>
      new Promise((resolve, reject) => {
        let channel: CockpitChannel;
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let responded = false;
        let settled = false;

        const stream = new ReadableStream<Uint8Array>({
          start: (c) => { controller = c; },
          cancel: () => { settled = true; channel.close('cancelled'); },
        });

        const onAbort = () => {
          if (settled) return;
          settled = true;
          channel.close('cancelled');
          if (responded) {
            try { controller.error(abortError()); } catch { /* already closed */ }
          } else {
            reject(abortError());
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });

        channel = ctx.cockpit.channel({
          payload: 'http-stream2',
          unix: ctx.socketPath(),
          binary: true,
          method: request.method,
          path: url.pathname + url.search,
          headers,
        });

        channel.addEventListener('control', (_event, options) => {
          if (options.command !== 'response' || responded) return;
          responded = true;
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(options.headers ?? {})) {
            try { responseHeaders.append(key, String(value)); } catch { /* skip invalid header */ }
          }
          const status = Number(options.status);
          const noBody = NULL_BODY_STATUS.has(status) || request.method === 'HEAD';
          resolve(new Response(noBody ? null : stream, { status, statusText: options.reason ?? '', headers: responseHeaders }));
          if (noBody) controller.close();
        });

        channel.addEventListener('message', (_event, data) => {
          if (settled) return;
          const chunk = typeof data === 'string' ? new TextEncoder().encode(data) : data;
          if (chunk.length > 0) controller.enqueue(chunk);
        });

        channel.addEventListener('close', (_event, options) => {
          signal.removeEventListener('abort', onAbort);
          if (settled) return;
          settled = true;
          if (!responded) {
            // The bridge could not connect: the backend most likely idle-exited. Nothing was sent, so a retry is safe.
            if (options.problem === 'not-found') return resolve('retry');
            return reject(new TypeError(options.message || options.problem || 'cockpit http channel failed'));
          }
          if (options.problem) {
            try { controller.error(new TypeError(options.message || options.problem)); } catch { /* already closed */ }
          } else {
            try { controller.close(); } catch { /* already closed */ }
          }
        });

        if (body && body.length > 0) channel.send(body);
        channel.control({ command: 'done' });
      });

    let result = await attempt();
    if (result === 'retry') {
      await ctx.ensure();
      result = await attempt();
      if (result === 'retry') throw new TypeError('Agent backend is not reachable');
    }
    return result;
  };
}
