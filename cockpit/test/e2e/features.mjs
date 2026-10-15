// Checks that features turned off in features.json are absent from the UI. Usage: PLAYWRIGHT_DIR=... node features.mjs
import os from 'node:os';
import path from 'node:path';
import { openPackage } from './harness.mjs';

const { browser, page, logs } = await openPackage();
const texts = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((b) => (b.getAttribute('aria-label') || b.innerText || '').trim()).filter(Boolean), sel);
let failed = false;
const expect = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); if (!ok) failed = true; };
try {
  await page.getByText('devops-agent-plugin', { exact: true }).first().click({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const tabs = await texts('[role=tab]');
  console.log('workspace tabs:', tabs.join(' | '));
  for (const t of ['Chat', 'Shell', 'Files', 'Source Control']) expect(`tab ${t}`, tabs.includes(t));
  for (const t of ['Tasks', 'Browser']) expect(`no tab ${t}`, !tabs.includes(t));

  await page.locator('button:visible', { hasText: /^\s*Settings\s*$/ }).first().click();
  await page.waitForTimeout(1500);
  const nav = await texts('aside nav button');
  console.log('settings nav:', nav.join(' | '));
  for (const gone of ['Voice', 'Tasks', 'Browser', 'Notifications', 'API']) expect(`settings has no ${gone}`, !nav.some((n) => n.includes(gone)), '');
  for (const kept of ['Agents', 'Appearance', 'Plugins']) expect(`settings has ${kept}`, nav.some((n) => n.includes(kept)));
  const pills = await texts('[role=dialog] button, .fixed button');
  expect('no Cursor/OpenCode provider in settings', !pills.some((p) => /^(Cursor|OpenCode)$/.test(p)), pills.filter((p) => /Cursor|OpenCode|Claude|Codex/.test(p)).join(','));
  expect('no taskmaster console error', !logs.some((l) => /TaskMaster/.test(l)));
  await page.screenshot({ path: path.join(process.env.SHOTS ?? os.tmpdir(), 'features-settings.png') });
} finally {
  console.log('--- logs ---\n' + logs.filter((l) => !/webgl|GroupMarker/i.test(l)).slice(0, 20).join('\n'));
  await browser.close();
}
process.exit(failed ? 1 : 0);
