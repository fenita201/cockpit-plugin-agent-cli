// Open a project, browse Files, open a file in the editor; prints CSP violations. Usage: PKG_DIR=<dir> node files.mjs [project] [file]
import os from 'node:os';
import path from 'node:path';
import { openPackage } from './harness.mjs';

const project = process.argv[2] ?? 'devops-agent-plugin';
const file = process.argv[3] ?? 'CLAUDE.md';
const pkgName = 'agent-ui-dev';
const pkgDir = process.env.PKG_DIR ?? path.join(os.homedir(), '.local/share/cockpit', pkgName);
const shot = (n) => path.join(process.env.SHOTS ?? os.tmpdir(), `files-${n}.png`);
const { browser, page, logs } = await openPackage({ pkgDir, pkgName });
try {
  await page.getByText(project, { exact: true }).first().click({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.getByText('Files', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.getByText(file, { exact: true }).first().click({ timeout: 10000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: shot('editor') });
  console.log('editor text sample:', (await page.locator('.cm-content').first().innerText().catch(() => 'NO EDITOR')).slice(0, 120));
} finally {
  console.log('--- logs ---\n' + logs.filter((l) => !/webgl|GroupMarker/i.test(l)).slice(0, 40).join('\n'));
  await browser.close();
}
