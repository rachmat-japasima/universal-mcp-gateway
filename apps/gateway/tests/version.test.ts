import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SERVICE_INFO } from '../src/shared/service.js';

/**
 * Version consistency (Phase 18, Stage E).
 *
 * The gateway version lives in exactly two places on purpose: `package.json`
 * (what npm publishes) and `SERVICE_INFO` (what every MCP handshake and API
 * response advertises). There is no third literal anywhere; the system route
 * reads `SERVICE_INFO`, and tests compare against it. This file exists so that
 * editing one without the other fails the suite instead of shipping a gateway
 * that lies about its own version.
 */
describe('service version', () => {
  it('agrees with package.json', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };

    expect(SERVICE_INFO.version).toBe(manifest.version);
  });
});
