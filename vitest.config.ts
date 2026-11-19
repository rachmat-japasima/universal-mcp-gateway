import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pinned to this package's own suite. Without it, vitest's default glob also
    // collects `apps/dashboard/**` and runs those jsdom/React tests in this
    // Node environment, where they fail for reasons unrelated to either suite.
    // The dashboard has its own config and its own `test` script.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests bind real loopback sockets and speak the real protocol.
    fileParallelism: false,
    env: { LOG_LEVEL: 'silent' },
  },
});
