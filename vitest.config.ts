import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Tests bind real loopback sockets and speak the real protocol.
    fileParallelism: false,
    env: { LOG_LEVEL: 'silent' },
  },
});
