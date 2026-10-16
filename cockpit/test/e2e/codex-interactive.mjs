// Real Codex chat: default provider, live steering, question choices, completion and resume.
// PLAYWRIGHT_DIR=/path/to/playwright PKG=agent-ui node cockpit/test/e2e/codex-interactive.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openPackage } from './harness.mjs';

const socketPath = path.join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`, process.env.PKG === 'agent-ui' ? 'agent-ui' : 'agent-ui-dev', 'server.sock');
const projectName = `aui-codex-test-${Date.now()}`;
const scratch = fs.mkdtempSync(path.join(os.homedir(), `${projectName}-`));
const api = (url, body) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath, method: 'POST', path: url, headers: { 'Content-Type': 'application/json' } }, (res) => {
    let data = ''; res.on('data', (chunk) => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: data }));
  });
  req.on('error', reject); req.end(JSON.stringify(body));
});
const { browser, page, logs } = await openPackage();
try {
  await page.waitForTimeout(1500);
  const result = await api('/api/projects/create-project', { path: scratch });
  assert.ok(result.status === 200 || result.status === 201, result.body);
  const session = await api('/api/providers/sessions', { provider: 'codex', projectPath: scratch, initialMessage: 'Codex integration test' });
  assert.ok(session.status === 200 || session.status === 201, session.body);
  const sessionId = JSON.parse(session.body).data.sessionId;
  await page.goto(`https://cockpit.test/cockpit/@localhost/agent-ui/index.html#/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
  const box = page.locator('textarea').first();
  await box.fill('Integration test: run sleep 8 using your command tool, then use the question tool request_user_input to ask me to choose Blue or Green. After I choose, reply with exactly CHOICE=<color> MARKER=<marker>, using the marker I send while you work. Do not edit files.');
  await box.press('Enter');
  await page.getByRole('button', { name: 'Stop', exact: true }).first().waitFor({ timeout: 30000 });
  await box.fill('The marker is COCKPIT_STEER_OK. Include it in your final answer.');
  await page.getByRole('button', { name: 'Steer active turn', exact: true }).waitFor({ timeout: 30000 });
  await box.press('Enter');
  const options = page.getByRole('radiogroup').first();
  await options.waitFor({ timeout: 120000 });
  await options.getByRole('button', { name: /Blue/ }).click();
  await page.getByRole('button', { name: /Submit/ }).click();
  await page.locator('.chat-message.assistant').filter({ hasText: 'CHOICE=Blue MARKER=COCKPIT_STEER_OK' }).waitFor({ timeout: 120000 });
  assert.match(await page.locator('body').innerText(), /COCKPIT_STEER_OK/);
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.chat-message.assistant').filter({ hasText: 'CHOICE=Blue' }).count(), 1, 'partial snapshots must not become duplicate bubbles');
  await box.fill('Reply with exactly RESUME_OK.');
  await box.press('Enter');
  await page.locator('.chat-message.assistant').filter({ hasText: 'RESUME_OK' }).waitFor({ timeout: 120000 });
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: '/tmp/agent-ui-codex-interactive.png', fullPage: true });
  console.log('PASS Codex default, live steer, clickable option, turn completion and second prompt');
} finally {
  const errors = logs.filter((line) => /pageerror|protocol_error|STEER_FAILED/i.test(line));
  console.log('Browser errors:', JSON.stringify(errors));
  await page.screenshot({ path: '/tmp/agent-ui-codex-interactive-last.png', fullPage: true }).catch(() => {});
  await browser.close();
}
