import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pinned to this package's own suite. The dashboard is a sibling workspace
    // package with its own vitest config, jsdom environment, and `test`
    // script; this suite stays Node-only and gateway-only, and never collects
    // files outside apps/gateway.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests bind real loopback sockets and speak the real protocol.
    fileParallelism: false,
    env: { LOG_LEVEL: 'silent' },
  },
});
