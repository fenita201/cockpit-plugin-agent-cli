import { defineConfig } from 'vitest/config';

// Shim tests run in plain node against a real unix-socket server (see cockpit/shim/test-server.ts).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['cockpit/**/*.test.ts'],
    exclude: ['cockpit/server/**', '**/node_modules/**'],
    testTimeout: 15000,
  },
});
