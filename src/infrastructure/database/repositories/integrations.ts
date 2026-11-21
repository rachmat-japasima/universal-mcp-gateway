import {
  integrationConnectionSchema,
  storedIntegrationCredentialSchema,
  type IntegrationConnection,
  type StoredIntegrationCredential,
} from '../../../integrations/connection.js';
import type {
  IntegrationConnectionRepository,
  IntegrationCredentialRepository,
} from '../../../domain/repositories.js';
import type { ConnectionStatus } from '../../../integrations/connection.js';
import { parseStored, wrapDatabaseError } from './helpers.js';
import type { SqliteDatabase } from '../connection.js';

/**
 * Managed-integration rows (migration 0008).
 *
 * Every row is validated through the domain schema on the way out — stored
 * data is never trusted, which is what makes a hand-edited database file fail
 * closed at the read boundary instead of poisoning the catalog.
 */

interface ConnectionRow {
  id: string;
  provider_id: string;
  name: string;
  status: string;
  credential_id: string | null;
  metadata_json: string;
  validated_at: string | null;
  created_at: string;
  updated_at: string;
}

function toConnection(row: ConnectionRow): IntegrationConnection {
  return parseStored(
    () =>
      integrationConnectionSchema.parse({
        id: row.id,
        providerId: row.provider_id,
        name: row.name,
        status: row.status,
        credentialId: row.credential_id,
        metadata: JSON.parse(row.metadata_json),
        validatedAt: row.validated_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    { connectionId: row.id },
  );
}

const CONNECTION_COLUMNS =
  'id, provider_id, name, status, credential_id, metadata_json, validated_at, created_at, updated_at';

export class SqliteIntegrationConnectionRepository implements IntegrationConnectionRepository {
  constructor(private readonly database: SqliteDatabase) {}

  create(connection: IntegrationConnection): IntegrationConnection {
    const parsed = integrationConnectionSchema.parse(connection);

    try {
      this.database
        .prepare(
          `INSERT INTO integration_connections (id, provider_id, name, status, credential_id, metadata_json,
             validated_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.providerId,
          parsed.name,
          parsed.status,
          parsed.credentialId,
          JSON.stringify(parsed.metadata),
          parsed.validatedAt,
          parsed.createdAt,
          parsed.updatedAt,
        );
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'integration_connections.create' });
    }

    return this.findById(parsed.id)!;
  }

  findById(id: string): IntegrationConnection | undefined {
    const row = this.database
      .prepare(`SELECT ${CONNECTION_COLUMNS} FROM integration_connections WHERE id = ?`)
      .get(id) as ConnectionRow | undefined;
    return row === undefined ? undefined : toConnection(row);
  }

  list(): IntegrationConnection[] {
    const rows = this.database
      .prepare(`SELECT ${CONNECTION_COLUMNS} FROM integration_connections ORDER BY created_at, id`)
      .all() as ConnectionRow[];
    return rows.map(toConnection);
  }

  updateStatus(
    id: string,
    status: ConnectionStatus,
    now: string,
    validatedAt?: string,
  ): IntegrationConnection | undefined {
    this.database
      .prepare(
        'UPDATE integration_connections SET status = ?, updated_at = ?, validated_at = COALESCE(?, validated_at) WHERE id = ?',
      )
      .run(status, now, validatedAt ?? null, id);
    return this.findById(id);
  }

  updateCredential(id: string, credentialId: string | null, now: string): IntegrationConnection | undefined {
    this.database
      .prepare('UPDATE integration_connections SET credential_id = ?, updated_at = ? WHERE id = ?')
      .run(credentialId, now, id);
    return this.findById(id);
  }

  update(id: string, fields: { name?: string; metadata?: Record<string, unknown> }, now: string): IntegrationConnection | undefined {
    const current = this.findById(id);
    if (current === undefined) return undefined;

    this.database
      .prepare(
        `UPDATE integration_connections SET name = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        fields.name ?? current.name,
        JSON.stringify(fields.metadata ?? current.metadata),
        now,
        id,
      );
    return this.findById(id);
  }

  remove(id: string): boolean {
    // Credential rows cascade at the database level (migration 0008), so a
    // deleted connection cannot leave a sealed secret behind.
    const result = this.database.prepare('DELETE FROM integration_connections WHERE id = ?').run(id);
    return result.changes > 0;
  }
}

interface CredentialRow {
  id: string;
  connection_id: string | null;
  envelope: string;
  created_at: string;
  updated_at: string;
}

function toCredential(row: CredentialRow): StoredIntegrationCredential {
  return parseStored(
    () =>
      storedIntegrationCredentialSchema.parse({
        id: row.id,
        connectionId: row.connection_id,
        envelope: row.envelope,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    { credentialId: row.id },
  );
}

export class SqliteIntegrationCredentialRepository implements IntegrationCredentialRepository {
  constructor(private readonly database: SqliteDatabase) {}

  create(credential: StoredIntegrationCredential): StoredIntegrationCredential {
    const parsed = storedIntegrationCredentialSchema.parse(credential);

    try {
      this.database
        .prepare(
          `INSERT INTO integration_credentials (id, connection_id, envelope, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(parsed.id, parsed.connectionId, parsed.envelope, parsed.createdAt, parsed.updatedAt);
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'integration_credentials.create' });
    }

    return this.findById(parsed.id)!;
  }

  findById(id: string): StoredIntegrationCredential | undefined {
    const row = this.database
      .prepare('SELECT id, connection_id, envelope, created_at, updated_at FROM integration_credentials WHERE id = ?')
      .get(id) as CredentialRow | undefined;
    return row === undefined ? undefined : toCredential(row);
  }

  remove(id: string): boolean {
    const result = this.database.prepare('DELETE FROM integration_credentials WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
