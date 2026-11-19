import type { CredentialKeys } from '../../src/auth/credential-key.js';
import { hashPassword } from '../../src/auth/operator-password.js';
import type { PublicOperator } from '../../src/domain/operator.js';
import type { Database } from '../../src/infrastructure/database/index.js';
import { createLogger } from '../../src/monitoring/logger.js';
import { OperatorService } from '../../src/registry/operator-service.js';

/**
 * Test-only operator plumbing.
 *
 * Sessions are minted by the *real* `OperatorService.login`, not by inserting a
 * session row directly. A fixture that hand-built a cookie would keep passing
 * after the login path broke, which is the failure this helper exists to catch.
 */

export const TEST_OPERATOR_USERNAME = 'test-operator';
export const TEST_OPERATOR_PASSWORD = 'test-only-operator-password';

const logger = createLogger({ logLevel: 'silent', environment: 'test' });

export interface TestOperatorSession {
  operator: PublicOperator;
  /** Cookie pair, ready for a `cookie` header. */
  cookie: string;
  csrfToken: string;
  /** Both headers a state-changing request needs, sans `host`. */
  headers: Record<string, string>;
  /** The service the fixture used, for tests that need to act on the session. */
  service: OperatorService;
}

export interface CreateTestOperatorOptions {
  username?: string;
  password?: string;
  /** Seconds of absolute lifetime. Tiny values make expiry testable without sleeping. */
  maxLifetimeMs?: number;
  idleTimeoutMs?: number;
}

/** Creates the operator row if absent and returns a live session for it. */
export function createTestOperator(
  store: Database,
  keys: CredentialKeys,
  options: CreateTestOperatorOptions = {},
): TestOperatorSession {
  const username = options.username ?? TEST_OPERATOR_USERNAME;
  const password = options.password ?? TEST_OPERATOR_PASSWORD;

  if (store.operators.findByUsername(username) === undefined) {
    store.operators.create(
      { username, passwordHash: hashPassword(password), role: 'owner' },
      new Date().toISOString(),
    );
  }

  const service = new OperatorService({
    store,
    keys,
    logger,
    idleTimeoutMs: options.idleTimeoutMs ?? 1_800_000,
    maxLifetimeMs: options.maxLifetimeMs ?? 43_200_000,
  });

  const result = service.login({ username, password });
  if (!result.ok) throw new Error(`test operator login failed: ${result.reason}`);

  const cookie = `umg_operator=${result.token}`;

  return {
    operator: result.operator,
    cookie,
    csrfToken: result.csrfToken,
    headers: { cookie, 'x-csrf-token': result.csrfToken },
    service,
  };
}
