import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import { hashPassword, isAcceptablePassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../auth/operator-password.js';
import { loadConfig, ConfigError } from '../config/config.js';
import { openStore, type Database } from '../infrastructure/database/index.js';
import { isOperatorUsernameTaken } from './operator-bootstrap.js';

/**
 * `pnpm operator:create` — initial operator bootstrap.
 *
 * Security properties, each a deliberate choice:
 *
 *  * **The password never arrives as an argument.** An argv password lands in
 *    shell history and in `ps` output for every local user; stdin or a TTY
 *    prompt does not.
 *  * **No default and no generated password.** A generated one would have to be
 *    printed somewhere to be usable, which turns a log into a credential store.
 *  * **It refuses when an operator already exists.** There is no `--force`: a
 *    recovery that silently overwrites a password would be an account takeover
 *    for anyone with shell access, and shell access is already the trust
 *    boundary this tool lives inside.
 *  * **It writes a hash, never the password.** scrypt with a per-row salt, in
 *    the same format the verifier parses.
 *
 * Exit codes: 0 created, 1 failure, 2 refused (already exists / bad input).
 */

const EXIT_FAILURE = 1;
const EXIT_REFUSED = 2;

function fail(message: string, code: number = EXIT_FAILURE): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** Reads one line from a TTY without echoing it. Falls back to plain stdin. */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;

    if (!input.isTTY || !output.isTTY) {
      // Piped: the caller is responsible for the pipe's confidentiality (for
      // example a password manager writing to stdin). Read one line.
      const lines: string[] = [];
      const reader = createInterface({ input, crlfDelay: Infinity });

      reader.on('line', (line) => lines.push(line));
      reader.on('close', () => resolve((lines[0] ?? '').trim()));
      reader.on('error', reject);
      return;
    }

    output.write(prompt);
    input.setRawMode(true);
    input.resume();

    let value = '';
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        const char = String.fromCharCode(byte);

        if (char === '\r' || char === '\n') {
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          output.write('\n');
          resolve(value);
          return;
        }

        if (char === '\u0003') {
          // Ctrl-C: behave like the shell would.
          input.setRawMode(false);
          output.write('\n');
          process.exit(EXIT_REFUSED);
        }

        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }

        if (byte >= 32) value += char;
      }
    };

    input.on('data', onData);
  });
}

async function main(): Promise<void> {
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
    if (isOperatorUsernameTaken(store)) {
      fail('An operator already exists. This command does not overwrite credentials; use a deliberate recovery procedure.', EXIT_REFUSED);
    }

    const username = process.env['OPERATOR_USERNAME']?.trim() || (await readSecret('Operator username: ')).trim();
    if (username === '' || username.length > 64) {
      fail('A username between 1 and 64 characters is required.', EXIT_REFUSED);
    }
    if (isOperatorUsernameTaken(store, username)) {
      fail(`The username "${username}" is already taken.`, EXIT_REFUSED);
    }

    const password = await readSecret(`Password (min ${MIN_PASSWORD_LENGTH} chars): `);
    if (!isAcceptablePassword(password)) {
      fail(`The password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`, EXIT_REFUSED);
    }

    if (process.stdin.isTTY) {
      const confirmation = await readSecret('Confirm password: ');
      if (confirmation !== password) {
        fail('The passwords do not match.', EXIT_REFUSED);
      }
    }

    // Only the hash is passed on. The plaintext stays in this scope and is not
    // logged, serialised, or written anywhere.
    const operator = store.operators.create(
      { username, passwordHash: hashPassword(password), role: 'owner' },
      new Date().toISOString(),
    );

    store.audit.append({
      id: randomUUID(),
      actorType: 'system',
      action: 'operator.created',
      targetType: 'operator',
      targetId: operator.id,
      result: 'success',
      metadata: { source: 'operator:create' },
      createdAt: new Date().toISOString(),
    });

    process.stdout.write(`Operator "${operator.username}" created (${operator.id}).\n`);
    process.stdout.write('Start the gateway, then sign in at the dashboard.\n');
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  fail(`Operator bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
});
