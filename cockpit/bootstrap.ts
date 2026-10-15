// Entry of the Cockpit page: start (or find) this user's backend, install the transport shims, then load the upstream app.
import { installShims } from './shim';
import type { CockpitApi } from './shim/types';

declare const cockpit: CockpitApi & {
  spawn(args: string[], options?: Record<string, unknown>): Promise<string>;
};

const LIB = typeof __AGENT_UI_LIB__ !== 'undefined' ? __AGENT_UI_LIB__ : '/usr/lib/agent-ui';

let socket = '';
let inFlight: Promise<string> | null = null;

/** Runs agent-ui-ensure (starts the backend if needed) and returns the socket path. Concurrent callers share one run. */
function ensure(): Promise<string> {
  inFlight ??= (async () => {
    try {
      const out = await (cockpit as any).spawn([`${LIB}/bin/agent-ui-ensure`], { err: 'message' });
      const line = String(out).trim().split('\n').pop() ?? '';
      socket = (JSON.parse(line) as { socket: string }).socket;
      return socket;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function setStatus(html: string): void {
  const root = document.getElementById('root');
  if (root) root.innerHTML = html;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

async function main(): Promise<void> {
  setStatus('<div style="padding:24px;font-family:sans-serif;color:#666">Starting the agent…</div>');
  await ensure();
  installShims({ cockpit, socketPath: () => socket, ensure });
  await import('../src/main');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
  setStatus(
    `<div style="padding:24px;font-family:sans-serif"><h3>AI Agent could not start</h3><pre style="white-space:pre-wrap">${escapeHtml(message)}</pre>` +
    `<p>Try this in Cockpit's Terminal: <code>${escapeHtml(LIB)}/bin/agent-ui-ensure</code></p></div>`,
  );
});
