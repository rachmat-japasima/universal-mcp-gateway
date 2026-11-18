import { randomUUID } from 'node:crypto';

import type { Agent, CreateAgentInput, UpdateAgentInput } from '../../../domain/agent.js';
import { agentSchema, createAgentSchema, updateAgentSchema } from '../../../domain/agent.js';
import type { AgentPage, AgentQuery, AgentRepository } from '../../../domain/repositories.js';
import { AppError } from '../../../shared/errors.js';
import type { SqliteDatabase } from '../connection.js';
import { parseStored, wrapDatabaseError } from './helpers.js';

const ACTIVE_AGENT = 'deleted_at IS NULL';

/** Whitelist: a sort field is interpolated into SQL, so it must never come from a client verbatim. */
const SORT_COLUMNS = {
  name: 'name',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  client_type: string | null;
  enabled: number;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  last_authenticated_at: string | null;
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
        ...(row.metadata_json === null ? {} : { metadata: JSON.parse(row.metadata_json) }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.last_authenticated_at === null ? {} : { lastAuthenticatedAt: row.last_authenticated_at }),
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
          `INSERT INTO agents (id, name, description, client_type, enabled, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          parsed.name,
          parsed.description ?? null,
          parsed.clientType ?? null,
          parsed.enabled ? 1 : 0,
          parsed.metadata === undefined ? null : JSON.stringify(parsed.metadata),
          now,
          now,
        );
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

  findByName(name: string): Agent | undefined {
    const row = this.database
      .prepare(`SELECT * FROM agents WHERE name = ? AND ${ACTIVE_AGENT}`)
      .get(name) as AgentRow | undefined;

    return row === undefined ? undefined : toAgent(row);
  }

  list(): Agent[] {
    const rows = this.database
      .prepare(`SELECT * FROM agents WHERE ${ACTIVE_AGENT} ORDER BY name`)
      .all() as AgentRow[];

    return rows.map(toAgent);
  }

  query(criteria: AgentQuery): AgentPage {
    const where = [ACTIVE_AGENT];
    const values: unknown[] = [];

    if (criteria.search !== undefined) {
      where.push('(name LIKE ? ESCAPE \'\\\' OR description LIKE ? ESCAPE \'\\\')');
      const pattern = `%${escapeLike(criteria.search)}%`;
      values.push(pattern, pattern);
    }
    if (criteria.enabled !== undefined) {
      where.push('enabled = ?');
      values.push(criteria.enabled ? 1 : 0);
    }
    if (criteria.clientType !== undefined) {
      where.push('client_type = ?');
      values.push(criteria.clientType);
    }

    const clause = where.join(' AND ');
    const column = SORT_COLUMNS[criteria.sort];
    const direction = criteria.order === 'asc' ? 'ASC' : 'DESC';

    const total = (
      this.database.prepare(`SELECT COUNT(*) AS count FROM agents WHERE ${clause}`).get(...values) as {
        count: number;
      }
    ).count;

    const rows = this.database
      .prepare(`SELECT * FROM agents WHERE ${clause} ORDER BY ${column} ${direction}, id ASC LIMIT ? OFFSET ?`)
      .all(...values, criteria.limit, criteria.offset) as AgentRow[];

    return { items: rows.map(toAgent), total };
  }

  update(id: string, input: UpdateAgentInput, now: string): Agent {
    const parsed = updateAgentSchema.parse(input);
    const existing = this.findById(id);
    if (existing === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested agent does not exist.', { details: { agentId: id } });
    }

    // `undefined` leaves a field untouched; `null` clears `clientType`/`metadata`.
    const clientType = parsed.clientType === undefined ? existing.clientType : (parsed.clientType ?? undefined);
    const description = parsed.description === undefined ? existing.description : parsed.description;
    const metadata = parsed.metadata === undefined ? existing.metadata : (parsed.metadata ?? undefined);

    try {
      this.database
        .prepare(
          `UPDATE agents
              SET name = ?, description = ?, client_type = ?, enabled = ?, metadata_json = ?, updated_at = ?
            WHERE id = ? AND ${ACTIVE_AGENT}`,
        )
        .run(
          parsed.name ?? existing.name,
          description ?? null,
          clientType ?? null,
          (parsed.enabled ?? existing.enabled) ? 1 : 0,
          metadata === undefined ? null : JSON.stringify(metadata),
          now,
          id,
        );
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'agents.update', agentId: id });
    }

    return this.requireById(id, 'The agent was updated but could not be read back.');
  }

  /**
   * Written on every successful authentication.
   *
   * Deliberately not routed through `update()`: this is a fact about a request,
   * not an operator edit, so it must not bump `updated_at` or produce an audit
   * row. Failure is tolerated by the caller, which is authenticating a request.
   */
  touchAuthentication(id: string, now: string): void {
    try {
      this.database.prepare('UPDATE agents SET last_authenticated_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id);
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'agents.touchAuthentication', agentId: id });
    }
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

/** `%`, `_`, and the escape character are literal in a search term, not wildcards. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
