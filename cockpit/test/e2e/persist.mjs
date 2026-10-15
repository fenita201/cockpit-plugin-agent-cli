// Checklist #8: start a slow agent run, close every tab, check the backend and the run survive, then reopen and see the result.
// Usage: PLAYWRIGHT_DIR=... [PKG=agent-ui] node persist.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPackage, selectModel } from './harness.mjs';

const projectName = 'aui-e2e-scratch';
const unit = process.env.PKG === 'agent-ui' ? 'agent-ui' : 'agent-ui-dev';
const marker = path.join(os.homedir(), projectName, 'persist-marker.txt');
fs.rmSync(marker, { force: true });
const sh = (cmd) => import('node:child_process').then(({ execSync }) => execSync(cmd, { encoding: 'utf8' }).trim());

let first = await openPackage();
await first.page.waitForTimeout(3000);
await first.page.getByText(projectName, { exact: true }).first().click({ timeout: 30000 });
await first.page.waitForTimeout(1000);
await first.page.getByText('New Session', { exact: true }).first().click();
await first.page.waitForTimeout(1500);
await selectModel(first.page, 'Default (recommended)');
const box = first.page.locator('textarea').first();
await box.fill(`Use the Bash tool to run exactly: sleep 20 && echo agent-survived > ${marker} ; then reply with a one-line confirmation`);
await box.press('Enter');
// wait until the tool is running, then close the browser (every tab) while the agent is still working
await first.page.waitForTimeout(8000);
const allow = first.page.getByRole('button', { name: /^(Allow|Allow once|Yes)$/ }).first();
if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {});
await first.page.waitForTimeout(3000);
console.log('marker before closing tabs:', fs.existsSync(marker));
await first.browser.close();
console.log('browser closed; unit:', await sh(`systemctl --user is-active ${unit}`));
await new Promise((r) => setTimeout(r, 35000));
console.log('35s later unit:', await sh(`systemctl --user is-active ${unit}`), '| marker exists:', fs.existsSync(marker), fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '');

const second = await openPackage();
await second.page.waitForTimeout(3000);
await second.page.getByText(projectName, { exact: true }).first().click({ timeout: 30000 });
await second.page.waitForTimeout(1000);
await second.page.getByText('Use the Bash tool', { exact: false }).first().click({ timeout: 15000 });
await second.page.waitForTimeout(3000);
const text = await second.page.evaluate(() => document.body.innerText);
const ok = fs.existsSync(marker) && text.includes('agent-survived');
await second.page.screenshot({ path: path.join(process.env.SHOTS ?? os.tmpdir(), 'persist.png') });
console.log(ok ? 'PASS agent kept running with no tab open and the result is visible after reopening' : 'FAIL');
await second.browser.close();
process.exit(ok ? 0 : 1);
