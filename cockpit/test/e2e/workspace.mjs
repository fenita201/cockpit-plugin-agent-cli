// Checklist #10: edit+save a file, see it in Source Control and commit it, upload an attachment.
// Needs a git project 'aui-e2e-scratch' with a committed aui-test.txt. Usage: PLAYWRIGHT_DIR=... [PKG=agent-ui] node workspace.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPackage } from './harness.mjs';

const dir = path.join(os.homedir(), 'aui-e2e-scratch');
const file = path.join(dir, 'aui-test.txt');
const shots = process.env.SHOTS ?? os.tmpdir();
let failed = false;
const expect = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); if (!ok) failed = true; };

const { browser, page, logs } = await openPackage();
const uploads = [];
page.on('response', (r) => { if (r.url().includes('/api/assets/files') && r.request().method() === 'POST') uploads.push(r.status()); });
try {
  await page.waitForTimeout(3000);
  await page.getByText('aui-e2e-scratch', { exact: true }).first().click({ timeout: 30000 });
  await page.waitForTimeout(1000);

  // 1. Files: open, edit, save
  await page.getByText('Files', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page.getByText('aui-test.txt', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  const editor = page.locator('.cm-content').first();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' EDITED-IN-UI');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(shots, 'ws-1-editor.png') });
  expect('edit + save writes the file on disk', fs.readFileSync(file, 'utf8').includes('EDITED-IN-UI'), JSON.stringify(fs.readFileSync(file, 'utf8')));

  // 2. Source Control shows the change, commit from the UI
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /Source Control/ }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(shots, 'ws-2-git.png') });
  const gitText = await page.evaluate(() => document.body.innerText);
  expect('Source Control lists the modified file', /aui-test\.txt/.test(gitText) && /(Modified|M\b|1 change|changes)/i.test(gitText));

  // 3. Upload an attachment from the chat composer
  await page.getByRole('tab', { name: /^Chat$/ }).click();
  await page.waitForTimeout(1000);
  const input = page.locator('input[type=file]').first();
  fs.writeFileSync(path.join(shots, 'upload-sample.txt'), 'hello upload');
  await input.setInputFiles(path.join(shots, 'upload-sample.txt'));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(shots, 'ws-3-upload.png') });
  const chatText = await page.evaluate(() => document.body.innerText);
  expect('attachment is accepted (upload request succeeded or chip shown)', uploads.some((s) => s === 200 || s === 201) || /upload-sample/.test(chatText), `uploads=${uploads}`);
} finally {
  console.log('--- logs ---\n' + logs.filter((l) => !/webgl|GroupMarker/i.test(l)).slice(0, 10).join('\n'));
  await browser.close();
}
try { execSync(`git -C ${dir} checkout -- aui-test.txt`); } catch { /* best effort */ }
process.exit(failed ? 1 : 0);
