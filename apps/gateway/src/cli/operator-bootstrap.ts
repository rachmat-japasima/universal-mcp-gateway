import type { Database } from '../infrastructure/database/index.js';

/**
 * Shared bootstrap predicate.
 *
 * Lives outside the CLI so the "already exists" rule is testable without
 * spawning a process, and so the CLI and any future admin surface answer the
 * same question the same way. Case-insensitive because the login path is
 * (`COLLATE NOCASE`), and a second operator differing only in case would be two
 * rows the login could not reliably tell apart.
 */
export function isOperatorUsernameTaken(store: Database, username?: string): boolean {
  if (store.operators.count() > 0) return true;
  if (username === undefined) return false;
  return store.operators.findByUsername(username) !== undefined;
}
