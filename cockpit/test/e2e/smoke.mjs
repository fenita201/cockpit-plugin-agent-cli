// Usage: PLAYWRIGHT_DIR=<dir with playwright> [PKG=agent-ui] node cockpit/test/e2e/smoke.mjs
import { openPackage } from './harness.mjs';

const { browser, page, logs, csp } = await openPackage();
console.log('CSP:', csp);
try {
  await page.waitForTimeout(Number(process.env.WAIT ?? 8000));
  console.log('--- page text ---\n' + (await page.evaluate(() => document.body.innerText.slice(0, 800))));
  await page.screenshot({ path: process.env.SHOT ?? 'smoke.png' });
} finally {
  console.log('--- logs ---\n' + logs.slice(0, 60).join('\n'));
  await browser.close();
}
