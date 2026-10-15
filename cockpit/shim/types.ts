// Minimal typings for the parts of cockpit.js the shims use (Cockpit 360). The real API is documented in
// cockpit's pkg/lib/cockpit.d.ts; cockpit.js itself is loaded by index.html (<script src="../base1/cockpit.js">).

export type CockpitChannelOptions = {
  payload: string;
  binary?: boolean;
  unix?: string;
  [option: string]: unknown;
};

export type CockpitChannelEvent = 'ready' | 'control' | 'message' | 'close';

export interface CockpitChannel {
  addEventListener(type: 'control', listener: (event: unknown, options: Record<string, any>) => void): void;
  addEventListener(type: 'message', listener: (event: unknown, data: Uint8Array | string) => void): void;
  addEventListener(type: 'ready', listener: (event: unknown, options?: Record<string, any>) => void): void;
  addEventListener(type: 'close', listener: (event: unknown, options: { problem?: string; message?: string }) => void): void;
  send(data: Uint8Array | string): void;
  control(options: Record<string, unknown>): void;
  close(problem?: string | Record<string, unknown>): void;
}

export interface CockpitApi {
  channel(options: CockpitChannelOptions): CockpitChannel;
}

/** What every shim needs to reach the backend. `ensure()` (re)starts the backend and returns the socket path. */
export type ShimContext = {
  cockpit: CockpitApi;
  /** Current unix socket path (updated when ensure() reports a different one). */
  socketPath: () => string;
  /** Idempotent and de-duplicated: concurrent callers share one in-flight call. */
  ensure: () => Promise<string>;
};

/** Paths that belong to the backend. Everything else (blobs, data URLs, other origins) is left to the browser. */
export const API_PATH_RE = /^\/(api|ws|shell|plugin-ws|health)(\/|$)/;

/** True when `url` points at this page's own host (http/https/ws/wss) and its path belongs to the backend. */
export function isBackendUrl(url: string | URL): boolean {
  const base = globalThis.location?.href ?? 'http://localhost/';
  try {
    const parsed = new URL(url.toString(), base);
    const scheme = parsed.protocol;
    if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'ws:' && scheme !== 'wss:') return false;
    // WebSocket URLs are built from window.location.host, so compare host (not origin).
    if (parsed.host !== new URL(base).host) return false;
    return API_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}
