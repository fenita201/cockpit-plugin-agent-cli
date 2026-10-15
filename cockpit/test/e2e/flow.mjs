// Exploratory flow: open a project, then Shell and Usage tabs. Usage: PLAYWRIGHT_DIR=... [SHOTS=dir] node flow.mjs [project]
import os from 'node:os';
import path from 'node:path';
import { openPackage } from './harness.mjs';

const project = process.argv[2] ?? 'devops-agent-plugin';
const shot = (n) => path.join(process.env.SHOTS ?? os.tmpdir(), `flow-${n}.png`);
const { browser, page, logs } = await openPackage();
try {
  await page.getByText(project, { exact: true }).first().click({ timeout: 20000 });
  await page.waitForTimeout(1500);

  await page.getByRole('tab', { name: /^Shell$/ }).or(page.getByText('Shell', { exact: true })).first().click();
  await page.waitForTimeout(4000);
  await page.keyboard.type('echo hello-from-shell $(whoami)\n', { delay: 20 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot('shell') });

  await page.getByText('Claude Usage', { exact: true }).first().click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: shot('claude-usage') });
  await page.getByText('Codex Usage', { exact: true }).first().click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: shot('codex-usage') });
} finally {
  console.log('--- logs ---\n' + logs.slice(0, 40).join('\n'));
  await browser.close();
}
