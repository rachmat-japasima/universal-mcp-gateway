import { loadConfig, ConfigError } from '../config/config.js';
import { openStore } from '../infrastructure/database/index.js';
import { createBackup, defaultBackupDestination } from './backup.js';

/**
 * `pnpm backup [destination]` — executable entry.
 *
 * Config and exit codes live here so the primitives in `backup.ts` stay
 * importable by tests; the same split as `operator-create.ts`.
 */

const EXIT_FAILURE = 1;

function fail(message: string, code: number = EXIT_FAILURE): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const [destinationArg] = process.argv.slice(2);
  if (destinationArg === '--help' || destinationArg === '-h') {
    process.stdout.write('Usage: pnpm backup [destination-file.db]\n');
    process.stdout.write('Default destination: backups/gateway-<timestamp>.db next to the database.\n');
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    fail(error instanceof ConfigError ? error.message : 'Invalid gateway configuration.');
  }

  const store = openStore({ path: config.databasePath });
  try {
    const destination = destinationArg ?? defaultBackupDestination(config.databasePath);
    const { path, migrationVersions } = await createBackup(store, destination);
    process.stdout.write(`Backup written to ${path} (${migrationVersions.length} migrations, integrity verified).\n`);
    process.stdout.write('Restore with: pnpm restore <file> --confirm (gateway stopped).\n');
  } catch (error) {
    fail(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  fail(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
});
