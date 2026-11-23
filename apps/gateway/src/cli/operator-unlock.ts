import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

import { loadConfig, ConfigError } from '../config/config.js';
import { openStore, type Database } from '../infrastructure/database/index.js';

/**
 * `pnpm operator:unlock [username]` — clears a lockout.
 *
 * Why this exists: five wrong passwords lock the account for 15 minutes, and
 * the login response deliberately does not say so (a uniform failure message is
 * the documented enumeration defence). Before this command the only recovery
 * was to wait, and any local process could renew the lock with five requests
 * every 15 minutes. Shell access is already the trust boundary that can create
 * the operator, so a shell-only unlock adds no new authority.
 *
 * The username may arrive as an argument, from `OPERATOR_USERNAME`, or on
 * stdin. A username is not a secret; a *password* would never be accepted this
 * way.
 *
 * Exit codes: 0 unlocked (or already unlocked), 1 failure, 2 refused.
 */

const EXIT_FAILURE = 1;
const EXIT_REFUSED = 2;

function fail(message: string, code: number = EXIT_FAILURE): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function readUsername(): Promise<string> {
  const argument = process.argv[2]?.trim();
  if (argument !== undefined && argument !== '') return argument;

  const fromEnvironment = process.env['OPERATOR_USERNAME']?.trim();
  if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment;

  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await input.question('Operator username: ')).trim();
  } finally {
    input.close();
  }
}

async function main(): Promise<void> {
  const username = await readUsername();
  if (username === '') fail('An operator username is required.', EXIT_REFUSED);

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    fail(error instanceof ConfigError ? error.message : 'Invalid gateway configuration.');
  }

  let store: Database;
  try {
    store = openStore({ path: config.databasePath });
  } catch (error) {
    fail(`Could not open the database at ${config.databasePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const operator = store.operators.findByUsername(username);
    if (operator === undefined) fail(`No operator named "${username}".`, EXIT_REFUSED);

    const now = new Date();
    const lockUntil = operator.lockedUntil === undefined ? undefined : Date.parse(operator.lockedUntil);
    const wasLocked = lockUntil !== undefined && lockUntil > now.getTime();

    store.operators.unlock(operator.id, now.toISOString());
    store.audit.append({
      id: randomUUID(),
      actorType: 'system',
      action: 'operator.unlocked',
      targetType: 'operator',
      targetId: operator.id,
      result: 'success',
      metadata: { source: 'operator:unlock', wasLocked },
      createdAt: now.toISOString(),
    });

    process.stdout.write(
      wasLocked
        ? `Unlocked "${operator.username}". Failed attempts reset; sign in with the existing password.\n`
        : `"${operator.username}" was not locked. Failed attempts reset.\n`,
    );
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  fail(`Operator unlock failed: ${error instanceof Error ? error.message : String(error)}`);
});
