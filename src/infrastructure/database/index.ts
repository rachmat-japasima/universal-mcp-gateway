import type { Repositories } from '../../domain/repositories.js';
import { openDatabase, closeDatabase, type SqliteDatabase } from './connection.js';
import { runMigrations, loadMigrations, type Migration } from './migration-runner.js';
import { SqliteAgentRepository } from './repositories/agents.js';
import { SqliteBackendRepository, SqliteBackendRuntimeRepository } from './repositories/backends.js';
import { SqliteCredentialRepository } from './repositories/credentials.js';
import { SqliteActivityRepository, SqliteAuditRepository, SqliteSessionRepository } from './repositories/events.js';
import { SqliteOperatorRepository } from './repositories/operators.js';
import { SqlitePolicyRepository } from './repositories/policies.js';
import {
  SqliteIntegrationConnectionRepository,
  SqliteIntegrationCredentialRepository,
} from './repositories/integrations.js';

export interface Database extends Repositories {
  /** Direct handle, for tests and future transactional services. Prefer repositories elsewhere. */
  handle: SqliteDatabase;
  close(): void;
  /** Runs a callback inside one transaction; rolls back on any throw. */
  transaction<T>(work: () => T): T;
}

export interface OpenStoreOptions {
  path: string;
  migrations?: Migration[];
}

/**
 * Opens the database, applies migrations, and wires repositories.
 *
 * The single-connection rule: one store, one handle. SQLite writers serialise
 * anyway, so a second connection would buy nothing but cross-handle coordination.
 */
export function openStore(options: OpenStoreOptions): Database {
  const handle = openDatabase({ path: options.path });

  try {
    runMigrations(handle, options.migrations ?? loadMigrations());
  } catch (error) {
    closeDatabase(handle);
    throw error;
  }

  return {
    handle,
    backends: new SqliteBackendRepository(handle),
    backendRuntime: new SqliteBackendRuntimeRepository(handle),
    agents: new SqliteAgentRepository(handle),
    credentials: new SqliteCredentialRepository(handle),
    policies: new SqlitePolicyRepository(handle),
    sessions: new SqliteSessionRepository(handle),
    activity: new SqliteActivityRepository(handle),
    audit: new SqliteAuditRepository(handle),
    operators: new SqliteOperatorRepository(handle),
    integrationConnections: new SqliteIntegrationConnectionRepository(handle),
    integrationCredentials: new SqliteIntegrationCredentialRepository(handle),
    transaction: (work) => handle.transaction(work)(),
    close: () => closeDatabase(handle),
  };
}
