import { loadConfig, ConfigError } from '../config/config.js';
import { restoreBackup, RestoreRefused } from './restore.js';

/**
 * `pnpm restore <source.db> --confirm` — executable entry.
 *
 * Config and exit codes live here so the primitive in `restore.ts` stays
 * importable by tests; the same split as `operator-create.ts`. Refusals exit
 * with code 2 (deliberate, safe-to-retry) and failures with 1.
 */

const EXIT_FAILURE = 1;
const EXIT_REFUSED = 2;

function fail(message: string, code: number = EXIT_FAILURE): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const source = args.find((arg) => arg !== '--confirm');

  if (source === undefined) {
    process.stdout.write('Usage: pnpm restore <backup-file.db> --confirm\n');
    fail('A backup file is required.', EXIT_REFUSED);
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    fail(error instanceof ConfigError ? error.message : 'Invalid gateway configuration.');
  }

  try {
    const { target, previousPath } = await restoreBackup({ source, target: config.databasePath, confirm });
    process.stdout.write(`Restored ${source} to ${target} (integrity verified).\n`);
    process.stdout.write(
      previousPath !== null
        ? `The previous database was preserved at ${previousPath}; delete it once the restore is confirmed good.\n`
        : 'No previous database existed; nothing was replaced.\n',
    );
    process.stdout.write(
      'Sealed integration credentials in the backup need the INTEGRATION_MASTER_KEY that was ' +
        'active when it was taken; with any other key they stay sealed. Next startup re-verifies migration checksums.\n',
    );
  } catch (error) {
    fail(
      error instanceof Error ? error.message : String(error),
      error instanceof RestoreRefused ? EXIT_REFUSED : EXIT_FAILURE,
    );
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
