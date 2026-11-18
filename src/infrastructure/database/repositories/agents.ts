import { randomUUID } from 'node:crypto';

import type { Agent, CreateAgentInput, UpdateAgentInput } from '../../../domain/agent.js';
import { agentSchema, createAgentSchema, updateAgentSchema } from '../../../domain/agent.js';
import type { AgentRepository } from '../../../domain/repositories.js';
import { AppError } from '../../../shared/errors.js';
import type { SqliteDatabase } from '../connection.js';
import { parseStored, wrapDatabaseError } from './helpers.js';

const ACTIVE_AGENT = 'deleted_at IS NULL';

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  client_type: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  deleted_at: string | null;
}

function toAgent(row: AgentRow): Agent {
  return parseStored(
    () =>
      agentSchema.parse({
        id: row.id,
        name: row.name,
        ...(row.description === null ? {} : { description: row.description }),
        ...(row.client_type === null ? {} : { clientType: row.client_type }),
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
      }),
    { agentId: row.id },
  );
}

export class SqliteAgentRepository implements AgentRepository {
  constructor(private readonly database: SqliteDatabase) {}

  create(input: CreateAgentInput, now: string): Agent {
    const parsed = createAgentSchema.parse(input);
    const id = randomUUID();

    try {
      this.database
        .prepare(
          `INSERT INTO agents (id, name, description, client_type, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, parsed.name, parsed.description ?? null, parsed.clientType ?? null, parsed.enabled ? 1 : 0, now, now);
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'agents.create' });
    }

    return this.requireById(id, 'The agent was written but could not be read back.');
  }

  findById(id: string): Agent | undefined {
    const row = this.database.prepare(`SELECT * FROM agents WHERE id = ? AND ${ACTIVE_AGENT}`).get(id) as
      | AgentRow
      | undefined;

    return row === undefined ? undefined : toAgent(row);
  }

  list(): Agent[] {
    const rows = this.database
      .prepare(`SELECT * FROM agents WHERE ${ACTIVE_AGENT} ORDER BY name`)
      .all() as AgentRow[];

    return rows.map(toAgent);
  }

  update(id: string, input: UpdateAgentInput, now: string): Agent {
    const parsed = updateAgentSchema.parse(input);
    const existing = this.findById(id);
    if (existing === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested agent does not exist.', { details: { agentId: id } });
    }

    // `undefined` leaves a field untouched; `null` clears `clientType`.
    const clientType = parsed.clientType === undefined ? existing.clientType : (parsed.clientType ?? undefined);
    const description = parsed.description === undefined ? existing.description : parsed.description;

    try {
      this.database
        .prepare(
          `UPDATE agents
              SET name = ?, description = ?, client_type = ?, enabled = ?, updated_at = ?
            WHERE id = ? AND ${ACTIVE_AGENT}`,
        )
        .run(
          parsed.name ?? existing.name,
          description ?? null,
          clientType ?? null,
          (parsed.enabled ?? existing.enabled) ? 1 : 0,
          now,
          id,
        );
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'agents.update', agentId: id });
    }

    return this.requireById(id, 'The agent was updated but could not be read back.');
  }

  softDelete(id: string, now: string): void {
    const result = this.database
      .prepare(`UPDATE agents SET deleted_at = ?, updated_at = ? WHERE id = ? AND ${ACTIVE_AGENT}`)
      .run(now, now, id);

    if (result.changes === 0) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested agent does not exist.', { details: { agentId: id } });
    }
  }

  countActive(): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM agents WHERE ${ACTIVE_AGENT}`).get() as {
      count: number;
    };
    return row.count;
  }

  private requireById(id: string, message: string): Agent {
    const agent = this.findById(id);
    if (agent === undefined) {
      throw new AppError('DATABASE_ERROR', message, { details: { agentId: id } });
    }
    return agent;
  }
}
