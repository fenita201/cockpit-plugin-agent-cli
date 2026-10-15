// Usage: PLAYWRIGHT_DIR=<dir with playwright> node cockpit/test/e2e/smoke.mjs [pkgDir] [pkgName]
import os from 'node:os';
import path from 'node:path';
import { openPackage } from './harness.mjs';

const pkgName = process.argv[3] ?? 'agent-ui-dev';
const pkgDir = process.argv[2] ?? path.join(os.homedir(), '.local/share/cockpit', pkgName);
const { browser, page, logs, csp } = await openPackage({ pkgDir, pkgName });
console.log('CSP:', csp);
try {
  await page.waitForTimeout(Number(process.env.WAIT ?? 8000));
  console.log('--- page text ---\n' + (await page.evaluate(() => document.body.innerText.slice(0, 800))));
  await page.screenshot({ path: process.env.SHOT ?? 'smoke.png' });
} finally {
  console.log('--- logs ---\n' + logs.slice(0, 60).join('\n'));
  await browser.close();
}
