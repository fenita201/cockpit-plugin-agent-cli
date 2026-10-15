// Real chat round-trip through the UI (uses the logged-in account's quota, keep prompts tiny).
// Usage: PLAYWRIGHT_DIR=... [PKG=agent-ui] node chat.mjs <model label> "<prompt>" "<expected substring>" [projectName]
//   model label examples: "Default (recommended)" (Claude), "GPT-5.5" (Codex)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openPackage, selectModel } from './harness.mjs';

const [modelLabel = 'Default (recommended)', prompt = 'Reply with exactly: PONG', expected = 'PONG', projectName = 'aui-e2e-scratch'] = process.argv.slice(2);
const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`;
const socketPath = path.join(runtime, process.env.PKG === 'agent-ui' ? 'agent-ui' : 'agent-ui-dev', 'server.sock');
const shots = process.env.SHOTS ?? os.tmpdir();
const scratch = path.join(os.homedir(), projectName);
fs.mkdirSync(scratch, { recursive: true });

const api = (method, url, body) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath, method, path: url, headers: { 'Content-Type': 'application/json' } }, (res) => {
    let data = ''; res.on('data', (d) => (data += d)); res.on('end', () => resolve({ status: res.statusCode, body: data }));
  });
  req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
});

const { browser, page, logs } = await openPackage();
let ok = false;
try {
  await page.waitForTimeout(3000); // backend is up now (ensure ran in the page)
  console.log('create-project:', (await api('POST', '/api/projects/create-project', { path: scratch })).status);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText(projectName, { exact: true }).first().click({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const newSession = page.getByText('New Session', { exact: true }).first();
  if (await newSession.isVisible().catch(() => false)) await newSession.click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shots, 'chat-1-empty.png') });

  // The empty state has a provider/model card; opening it lists every enabled provider's models.
  await selectModel(page, modelLabel);

  const box = page.locator('textarea').first();
  await box.click();
  await box.fill(prompt);
  await page.screenshot({ path: path.join(shots, 'chat-2-typed.png') });
  await box.press('Enter');
  const deadline = Date.now() + Number(process.env.CHAT_TIMEOUT_MS ?? 120000);
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => document.body.innerText);
    // the prompt itself contains the expected text only if the user typed it; require it at least twice
    if ((text.split(expected).length - 1) >= (prompt.includes(expected) ? 2 : 1)) { ok = true; break; }
    // approve a tool permission prompt if one appears
    const allow = page.getByRole('button', { name: /^(Allow|Allow once|Yes)$/ }).first();
    if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shots, 'chat-3-reply.png') });
  console.log(ok ? `PASS reply contains "${expected}"` : `FAIL no "${expected}" in the page`);
} finally {
  console.log('--- logs ---\n' + logs.filter((l) => !/webgl|GroupMarker/i.test(l)).slice(0, 20).join('\n'));
  await browser.close();
}
process.exit(ok ? 0 : 1);
