import { randomUUID } from 'node:crypto';

import type { AgentCredential, CreateCredentialInput } from '../../../domain/agent-credential.js';
import { agentCredentialSchema, createCredentialSchema } from '../../../domain/agent-credential.js';
import type { CredentialRepository } from '../../../domain/repositories.js';
import { AppError } from '../../../shared/errors.js';
import type { SqliteDatabase } from '../connection.js';
import { parseStored, wrapDatabaseError } from './helpers.js';

interface CredentialRow {
  id: string;
  agent_id: string;
  credential_hash: string;
  token_prefix: string | null;
  hash_key_id: string | null;
  label: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

function toCredential(row: CredentialRow): AgentCredential {
  return parseStored(
    () =>
      agentCredentialSchema.parse({
        id: row.id,
        agentId: row.agent_id,
        credentialHash: row.credential_hash,
        ...(row.token_prefix === null ? {} : { tokenPrefix: row.token_prefix }),
        ...(row.hash_key_id === null ? {} : { hashKeyId: row.hash_key_id }),
        ...(row.label === null ? {} : { label: row.label }),
        createdAt: row.created_at,
        ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
        ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
        ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
      }),
    { credentialId: row.id },
  );
}

/**
 * Credential storage. There is intentionally no `delete`: revocation is a
 * timestamp so an audit trail can always resolve the credential that was used.
 */
export class SqliteCredentialRepository implements CredentialRepository {
  constructor(private readonly database: SqliteDatabase) {}

  create(input: CreateCredentialInput, now: string): AgentCredential {
    const parsed = createCredentialSchema.parse(input);
    const id = randomUUID();

    try {
      this.database
        .prepare(
          `INSERT INTO agent_credentials (id, agent_id, credential_hash, token_prefix, hash_key_id, label, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          parsed.agentId,
          parsed.credentialHash,
          parsed.tokenPrefix ?? null,
          parsed.hashKeyId ?? null,
          parsed.label ?? null,
          now,
          parsed.expiresAt ?? null,
        );
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'agent_credentials.create', agentId: parsed.agentId });
    }

    const created = this.findById(id);
    if (created === undefined) {
      throw new AppError('DATABASE_ERROR', 'The credential was written but could not be read back.', {
        details: { credentialId: id },
      });
    }

    return created;
  }

  findById(id: string): AgentCredential | undefined {
    const row = this.database.prepare('SELECT * FROM agent_credentials WHERE id = ?').get(id) as
      | CredentialRow
      | undefined;

    return row === undefined ? undefined : toCredential(row);
  }

  findByHash(credentialHash: string): AgentCredential | undefined {
    const row = this.database.prepare('SELECT * FROM agent_credentials WHERE credential_hash = ?').get(credentialHash) as
      | CredentialRow
      | undefined;

    return row === undefined ? undefined : toCredential(row);
  }

  listByAgentId(agentId: string): AgentCredential[] {
    const rows = this.database
      .prepare('SELECT * FROM agent_credentials WHERE agent_id = ? ORDER BY created_at DESC')
      .all(agentId) as CredentialRow[];

    return rows.map(toCredential);
  }

  revoke(id: string, now: string): AgentCredential {
    // First revocation wins: re-revoking keeps the original timestamp so the
    // audit trail does not silently move.
    const result = this.database
      .prepare('UPDATE agent_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, id);

    const credential = this.findById(id);
    if (credential === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested credential does not exist.', {
        details: { credentialId: id },
      });
    }

    if (result.changes === 0 && credential.revokedAt === undefined) {
      throw new AppError('RESOURCE_CONFLICT', 'The credential could not be revoked.', {
        details: { credentialId: id },
      });
    }

    return credential;
  }

  revokeAllForAgent(agentId: string, now: string): number {
    try {
      const result = this.database
        .prepare('UPDATE agent_credentials SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL')
        .run(now, agentId);
      return result.changes;
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'agent_credentials.revokeAll', agentId });
    }
  }

  touch(id: string, now: string): void {
    try {
      this.database.prepare('UPDATE agent_credentials SET last_used_at = ? WHERE id = ?').run(now, id);
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'agent_credentials.touch', credentialId: id });
    }
  }
}
