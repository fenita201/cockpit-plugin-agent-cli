// Browser E2E harness WITHOUT a Cockpit login: serves the built package from disk at a fake origin with the CSP
// Cockpit would send (computed from manifest.json exactly like cockpit/packages.py), and replaces cockpit.js with a fake
// whose channels (http-stream2 / stream) and spawn() are executed Node-side against the real backend socket.
// Nothing listens on the network. Needs playwright: set PLAYWRIGHT_DIR to a dir whose node_modules has it, and
// PLAYWRIGHT_HOST_PLATFORM_OVERRIDE / PW_EXE for unsupported distros (see cockpit/test/e2e/README.md).
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR ?? process.cwd(), 'noop.js'));
const { chromium } = require('playwright');

const ORIGIN = 'https://cockpit.test';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json', '.png': 'image/png' };

function cspFromManifest(manifest) {
  const policy = { 'default-src': "'self'", 'connect-src': "'self'", 'form-action': "'self'", 'base-uri': "'self'", 'object-src': "'none'", 'font-src': "'self' data:", 'img-src': "'self' data:" };
  for (const item of (manifest['content-security-policy'] ?? '').split(';')) {
    const t = item.trim();
    if (!t) continue;
    const i = t.indexOf(' ');
    policy[i < 0 ? t : t.slice(0, i)] = i < 0 ? '' : t.slice(i + 1);
  }
  return Object.entries(policy).map(([k, v]) => `${k} ${v};`).join(' ') + ' block-all-mixed-content';
}

const FAKE_COCKPIT = `
(() => {
  const chans = {}; let n = 0;
  const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  window.cockpit = {
    channel(options) {
      const id = ++n; const listeners = {}; chans[id] = listeners;
      const ch = {
        options,
        addEventListener(t, f) { (listeners[t] ||= []).push(f); },
        send(d) { window.__cp_send(id, typeof d === 'string' ? { s: d } : { b: b64(d) }); },
        control(o) { window.__cp_control(id, o); },
        close(p) { window.__cp_close(id, p); },
      };
      window.__cp_open(id, options);
      return ch;
    },
    spawn(args, opts) { return window.__cp_spawn(args); },
  };
  window.__cp_emit = (id, type, arg) => {
    const out = arg && arg.b ? unb64(arg.b) : (arg && arg.s !== undefined ? arg.s : arg);
    for (const f of (chans[id]?.[type] ?? [])) f({}, out);
  };
})();`;

/** Node-side implementation of the channels the shims use. */
async function attachBridge(page) {
  const open = new Map();
  const emit = (id, type, arg) => page.evaluate(([i, t, a]) => window.__cp_emit(i, t, a), [id, type, arg]).catch(() => {});
  const b64 = (buf) => ({ b: Buffer.from(buf).toString('base64') });

  await page.exposeFunction('__cp_open', (id, o) => {
    const st = { o, body: [], closed: false };
    open.set(id, st);
    const close = (opts) => { if (st.closed) return; st.closed = true; emit(id, 'close', opts ?? {}); };
    st.close = close;
    if (o.payload === 'stream') {
      const sock = net.createConnection(o.unix);
      st.sock = sock;
      st.queue = [];
      sock.on('connect', () => { emit(id, 'ready'); for (const d of st.queue) sock.write(d); st.queue = []; });
      sock.on('data', (d) => emit(id, 'message', b64(d)));
      sock.on('end', () => close({}));
      sock.on('close', () => close({}));
      sock.on('error', (e) => close({ problem: e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'not-found' : 'terminated', message: e.message }));
    } else if (o.payload !== 'http-stream2') {
      close({ problem: 'not-supported' });
    }
  });
  await page.exposeFunction('__cp_send', (id, d) => {
    const st = open.get(id); if (!st) return;
    const buf = d.s !== undefined ? Buffer.from(d.s) : Buffer.from(d.b, 'base64');
    if (st.o.payload === 'http-stream2') st.body.push(buf);
    else if (st.sock && !st.sock.connecting) st.sock.write(buf); else st.queue?.push(buf);
  });
  await page.exposeFunction('__cp_control', (id, c) => {
    const st = open.get(id); if (!st || c.command !== 'done' || st.o.payload !== 'http-stream2') return;
    const o = st.o;
    const req = http.request({ socketPath: o.unix, method: o.method, path: o.path, headers: o.headers }, (res) => {
      const headers = {};
      for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
      emit(id, 'control', { command: 'response', status: res.statusCode, reason: res.statusMessage, headers });
      res.on('data', (d) => emit(id, 'message', b64(d)));
      res.on('end', () => st.close({}));
      res.on('error', (e) => st.close({ problem: 'terminated', message: e.message }));
    });
    st.req = req;
    req.on('error', (e) => st.close({ problem: e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'not-found' : 'terminated', message: e.message }));
    for (const b of st.body) req.write(b);
    req.end();
  });
  await page.exposeFunction('__cp_close', (id, p) => {
    const st = open.get(id); if (!st) return;
    st.req?.destroy(); st.sock?.destroy();
    st.close(typeof p === 'string' ? { problem: p } : (p ?? {}));
  });
  // cockpit.spawn: run the command as the current user, like cockpit-bridge would.
  await page.exposeFunction('__cp_spawn', (args) => new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `exit ${code}`))));
  }));
}

/** Launch headless Chromium showing the built package at https://cockpit.test/cockpit/@localhost/<pkg>/index.html */
export async function openPackage({ pkgDir, pkgName, viewport = { width: 1400, height: 900 }, prepare } = {}) {
  // PKG=agent-ui tests the system install; the default is the dev copy under ~/.local/share/cockpit.
  pkgName = process.env.PKG ?? pkgName ?? 'agent-ui-dev';
  pkgDir = process.env.PKG_DIR ?? pkgDir ?? (pkgName === 'agent-ui' ? '/usr/share/cockpit/agent-ui' : path.join(os.homedir(), '.local/share/cockpit', pkgName));
  const exe = process.env.PW_EXE ?? path.join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1193/chrome-linux/headless_shell');
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));

  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'manifest.json'), 'utf8'));
  const csp = cspFromManifest(manifest);
  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const base = `/cockpit/@localhost/`;
    if (url.pathname === `${base}base1/cockpit.js`) return route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_COCKPIT });
    if (url.pathname.startsWith(`${base}${pkgName}/`)) {
      let rel = url.pathname.slice(`${base}${pkgName}/`.length) || 'index.html';
      const file = path.join(pkgDir, rel);
      if (!file.startsWith(pkgDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { logs.push(`[404] ${url.pathname}`); return route.fulfill({ status: 404, body: 'not found' }); }
      const ext = path.extname(file);
      const headers = { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' };
      if (ext === '.html') headers['Content-Security-Policy'] = csp;
      return route.fulfill({ status: 200, headers, body: fs.readFileSync(file) });
    }
    logs.push(`[404] ${url.pathname} (outside package)`);
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await attachBridge(page);
  if (prepare) await prepare(page);
  await page.goto(`${ORIGIN}/cockpit/@localhost/${pkgName}/index.html`, { waitUntil: 'domcontentloaded' });
  return { browser, context, page, logs, csp };
}

/** In a new session's empty state: open the provider/model card and choose a model by its visible label. */
export async function selectModel(page, label) {
  try {
    await page.getByText('Click to change model').first().click({ timeout: 10000 });
    await page.getByRole('dialog').getByText(label, { exact: true }).first().click({ timeout: 10000 });
  } catch (error) {
    console.log('model pick skipped:', error.message.split('\n')[0]);
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(800);
}
