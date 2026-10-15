// Checklist #12/#14: a user with no agent login and no projects, in a desktop and a phone-sized viewport.
// Run with an empty HOME and its own unit, e.g.:
//   T=$(mktemp -d) HOME=$T AGENT_UI_LINGER=0 AGENT_UI_UNIT=agent-ui-test AGENT_UI_RUN_NAME=agent-ui-test PW_EXE=... PKG=agent-ui PLAYWRIGHT_DIR=... node newuser.mjs
import os from 'node:os';
import path from 'node:path';
import { openPackage } from './harness.mjs';

const shots = process.env.SHOTS ?? os.tmpdir();
let failed = false;
const expect = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); if (!ok) failed = true; };

for (const [label, viewport] of [['desktop', { width: 1400, height: 900 }], ['phone', { width: 390, height: 780 }]]) {
  const { browser, page, logs } = await openPackage({ viewport });
  try {
    await page.waitForTimeout(6000);
    const body = await page.evaluate(() => document.body.innerText);
    expect(`${label}: app renders without a login screen`, body.length > 20 && !/password/i.test(body));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(`${label}: no horizontal overflow`, !overflow);
    await page.screenshot({ path: path.join(shots, `newuser-${label}.png`) });
    if (label === 'desktop') {
      // Upstream onboarding for a user who has never used the app: git identity, then "Connect Agents".
      expect('desktop: first-run onboarding is shown', /Git Configuration/.test(body));
      await page.getByPlaceholder('John Doe').fill('Test User');
      await page.getByPlaceholder('john@example.com').fill('test@example.com');
      await page.getByRole('button', { name: /Next/ }).click();
      await page.waitForTimeout(2500);
      const text = await page.evaluate(() => document.body.innerText);
      console.log('connect step text:', text.replace(/\s+/g, ' ').slice(0, 500));
      await page.screenshot({ path: path.join(shots, 'newuser-connect.png') });
      expect('desktop: Claude and Codex login are offered', /Claude/.test(text) && /Codex/.test(text) && /login|log in|sign in|connect/i.test(text));
      expect('desktop: Cursor/OpenCode are not offered', !/Cursor|OpenCode/.test(text));
      // The Login button opens an embedded terminal (a /shell WebSocket) running the provider's login command.
      await page.getByRole('button', { name: /^Login$/ }).first().click();
      await page.waitForTimeout(6000);
      await page.screenshot({ path: path.join(shots, 'newuser-login-terminal.png') });
      const term = await page.evaluate(() => document.body.innerText);
      expect('desktop: login terminal opened without a path error', /Claude CLI Login|login/i.test(term) && !/ENOENT|no such file|not a directory/i.test(term));
    }
    expect(`${label}: no console errors`, !logs.some((l) => /console.error|pageerror/.test(l)), logs.slice(0, 3).join(' '));
  } finally {
    await browser.close();
  }
}
process.exit(failed ? 1 : 0);
