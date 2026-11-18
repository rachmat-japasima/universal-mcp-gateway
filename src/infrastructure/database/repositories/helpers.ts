import { AppError } from '../../../shared/errors.js';

/** Shared helpers for SQLite repositories: driver-error mapping and row parsing. */

/**
 * SQLite messages contain table and column names, and some contain absolute
 * paths. They are useful in logs and unsafe in responses, so they become the
 * `cause` of an `AppError` and never the message.
 */
export function wrapDatabaseError(error: unknown, context: Record<string, unknown>): AppError {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('UNIQUE constraint failed')) {
    return new AppError('RESOURCE_CONFLICT', 'A resource with that identity already exists.', {
      cause: error,
      details: context,
    });
  }

  if (message.includes('FOREIGN KEY constraint failed')) {
    return new AppError('VALIDATION_ERROR', 'A referenced resource does not exist.', {
      cause: error,
      details: context,
    });
  }

  if (message.includes('CHECK constraint failed')) {
    return new AppError('VALIDATION_ERROR', 'A value violates a storage constraint.', {
      cause: error,
      details: context,
    });
  }

  return new AppError('DATABASE_ERROR', 'The database operation failed.', { cause: error, details: context });
}

/** Validates a row read from storage; a mismatch is a data-integrity bug, not a client error. */
export function parseStored<T>(parse: () => T, context: Record<string, unknown>): T {
  try {
    return parse();
  } catch (error) {
    throw new AppError('DATABASE_ERROR', 'Stored data does not match the expected shape.', {
      cause: error,
      details: context,
    });
  }
}
