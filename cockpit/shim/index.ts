import { createEventSource } from './eventsource';
import { createFetch } from './fetch';
import type { ShimContext } from './types';
import { createWebSocket } from './websocket';

export type { ShimContext } from './types';

/**
 * Replaces window.fetch / EventSource / WebSocket so that URLs for the backend (/api, /ws, /shell, ...) travel over
 * Cockpit channels to the backend's unix socket. Upstream code keeps using the standard browser APIs unchanged.
 */
export function installShims(ctx: ShimContext, target: Window & typeof globalThis = window): void {
  const shimmedFetch = createFetch(ctx, target.fetch.bind(target));
  target.fetch = shimmedFetch;
  target.EventSource = createEventSource(shimmedFetch, target.EventSource);
  target.WebSocket = createWebSocket(ctx, target.WebSocket);
}
