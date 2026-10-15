// Frontend build for the Cockpit package. Extends upstream's vite.config.js; run from the repo root:
//   VITE_IS_PLATFORM=true npx vite build --config cockpit/vite.config.cockpit.ts
// Env: AGENT_UI_LIB (where agent-ui-ensure lives at runtime), AGENT_UI_OUT_DIR (default build/cockpit-ui).
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, mergeConfig, type Plugin, type UserConfig } from 'vite';

import baseConfig from '../vite.config.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Platform mode (no login screen) is chosen at build time; set it before Vite loads env.
process.env.VITE_IS_PLATFORM = 'true';

// public/ is not copied wholesale: only the logo the UI actually shows.
const copyLogo = (): Plugin => ({
  name: 'cockpit-copy-logo',
  closeBundle() {
    const out = process.env.AGENT_UI_OUT_DIR ?? path.join(repo, 'build/cockpit-ui');
    mkdirSync(out, { recursive: true });
    copyFileSync(path.join(repo, 'public/logo.svg'), path.join(out, 'logo.svg'));
  },
});

export default defineConfig((env) => {
  const base = (typeof baseConfig === 'function' ? baseConfig(env) : baseConfig) as UserConfig;
  const features = JSON.parse(readFileSync(path.join(repo, 'cockpit/features.json'), 'utf8'));
  return mergeConfig(base, {
    root: path.join(repo, 'cockpit'),
    envDir: repo,
    base: './',
    publicDir: false,
    plugins: [copyLogo()],
    css: { postcss: repo },
    resolve: { alias: { '@cockpit': path.join(repo, 'cockpit') } },
    define: {
      'import.meta.env.VITE_IS_PLATFORM': JSON.stringify('true'),
      __AGENT_UI_FEATURES__: JSON.stringify(features),
      __AGENT_UI_LIB__: JSON.stringify(process.env.AGENT_UI_LIB ?? '/usr/lib/agent-ui'),
      __AGENT_UI_COCKPIT__: 'true',
    },
    build: {
      outDir: process.env.AGENT_UI_OUT_DIR ?? path.join(repo, 'build/cockpit-ui'),
      emptyOutDir: true,
      rollupOptions: { input: path.join(repo, 'cockpit/index.html') },
    },
  } satisfies UserConfig);
});
