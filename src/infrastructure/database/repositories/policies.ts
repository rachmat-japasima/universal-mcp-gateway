import { randomUUID } from 'node:crypto';

import type { CreatePolicyInput, Policy, UpdatePolicyInput } from '../../../domain/policy.js';
import { createPolicySchema, policySchema, updatePolicySchema } from '../../../domain/policy.js';
import type { PolicyPage, PolicyQuery, PolicyRepository } from '../../../domain/repositories.js';
import { AppError } from '../../../shared/errors.js';
import type { SqliteDatabase } from '../connection.js';
import { parseStored, wrapDatabaseError } from './helpers.js';

interface PolicyRow {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  rules_json: string;
  created_at: string;
  updated_at: string;
}

function toPolicy(row: PolicyRow): Policy {
  const rules: unknown = JSON.parse(row.rules_json);

  return parseStored(
    () =>
      policySchema.parse({
        id: row.id,
        name: row.name,
        ...(row.description === null ? {} : { description: row.description }),
        priority: row.priority,
        rules,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    { policyId: row.id },
  );
}

/** Policies are shared, reusable objects; assigning one to an agent does not copy it. */
export class SqlitePolicyRepository implements PolicyRepository {
  constructor(private readonly database: SqliteDatabase) {}

  create(input: CreatePolicyInput, now: string): Policy {
    const parsed = createPolicySchema.parse(input);
    const id = randomUUID();

    try {
      this.database
        .prepare(
          `INSERT INTO policies (id, name, description, priority, rules_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          parsed.name,
          parsed.description ?? null,
          parsed.priority,
          JSON.stringify(parsed.rules),
          now,
          now,
        );
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'policies.create' });
    }

    const created = this.findById(id);
    if (created === undefined) {
      throw new AppError('DATABASE_ERROR', 'The policy was written but could not be read back.', {
        details: { policyId: id },
      });
    }

    return created;
  }

  findById(id: string): Policy | undefined {
    const row = this.database.prepare('SELECT * FROM policies WHERE id = ?').get(id) as PolicyRow | undefined;
    return row === undefined ? undefined : toPolicy(row);
  }

  findByName(name: string): Policy | undefined {
    const row = this.database.prepare('SELECT * FROM policies WHERE name = ?').get(name) as PolicyRow | undefined;
    return row === undefined ? undefined : toPolicy(row);
  }

  list(): Policy[] {
    const rows = this.database.prepare('SELECT * FROM policies ORDER BY name').all() as PolicyRow[];
    return rows.map(toPolicy);
  }

  /**
   * Paged listing.
   *
   * `agentId`, `search` and `backendId` are pushed into SQL. The effect filter
   * is applied afterwards because an effect lives inside `rules_json`: SQLite's
   * `json_each` can answer "does any rule carry this effect" in one statement
   * and the backend filter already does — so paging and `total` stay honest for
   * every filter, which they were not when the backend filter ran on a page.
   *
   * ponytail: in-memory effect filter + sort. Move to a `policy_rules` table when
   * policy counts grow past what one process can cheaply scan.
   */
  query(criteria: PolicyQuery): PolicyPage {
    const where: string[] = [];
    const values: unknown[] = [];
    let join = '';

    if (criteria.agentId !== undefined) {
      join = 'JOIN agent_policy_assignments a ON a.policy_id = p.id';
      where.push('a.agent_id = ?');
      values.push(criteria.agentId);
    }
    if (criteria.search !== undefined) {
      where.push('(p.name LIKE ? ESCAPE \'\\\' OR p.description LIKE ? ESCAPE \'\\\')');
      const pattern = `%${escapeLike(criteria.search)}%`;
      values.push(pattern, pattern);
    }
    if (criteria.backendId !== undefined) {
      // A policy matches a backend when any rule targets that backend id, or
      // everything (`*`). `json_valid` guards a hand-edited row.
      where.push(
        `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(p.rules_json) THEN p.rules_json ELSE '[]' END) r
                  WHERE json_extract(r.value, '$.resource') = 'backend'
                    AND json_extract(r.value, '$.target') IN (?, '*'))`,
      );
      values.push(criteria.backendId);
    }

    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
    const rows = this.database
      .prepare(`SELECT p.* FROM policies p ${join} ${clause}`)
      .all(...values) as PolicyRow[];

    const filtered = rows
      .map(toPolicy)
      .filter((policy) => criteria.effect === undefined || policy.rules.some((rule) => rule.effect === criteria.effect));

    const direction = criteria.order === 'asc' ? 1 : -1;
    filtered.sort((a, b) => direction * sortValue(a, b, criteria.sort));

    const total = filtered.length;
    return { items: filtered.slice(criteria.offset, criteria.offset + criteria.limit), total };
  }

  update(id: string, input: UpdatePolicyInput, now: string): Policy {
    const parsed = updatePolicySchema.parse(input);
    const existing = this.findById(id);
    if (existing === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested policy does not exist.', { details: { policyId: id } });
    }

    const description = parsed.description === undefined ? existing.description : parsed.description;

    try {
      this.database
        .prepare(
          `UPDATE policies
              SET name = ?, description = ?, priority = ?, rules_json = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          parsed.name ?? existing.name,
          description ?? null,
          parsed.priority ?? existing.priority,
          JSON.stringify(parsed.rules ?? existing.rules),
          now,
          id,
        );
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'policies.update', policyId: id });
    }

    const updated = this.findById(id);
    if (updated === undefined) {
      throw new AppError('DATABASE_ERROR', 'The policy was updated but could not be read back.', {
        details: { policyId: id },
      });
    }

    return updated;
  }

  /** Hard delete: assignments cascade, and nothing historic references a policy id. */
  delete(id: string): void {
    const result = this.database.prepare('DELETE FROM policies WHERE id = ?').run(id);
    if (result.changes === 0) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested policy does not exist.', { details: { policyId: id } });
    }
  }

  assign(agentId: string, policyId: string, now: string): void {
    try {
      this.database
        .prepare('INSERT INTO agent_policy_assignments (agent_id, policy_id, created_at) VALUES (?, ?, ?)')
        .run(agentId, policyId, now);
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'agent_policy_assignments.assign', agentId, policyId });
    }
  }

  unassign(agentId: string, policyId: string): void {
    const result = this.database
      .prepare('DELETE FROM agent_policy_assignments WHERE agent_id = ? AND policy_id = ?')
      .run(agentId, policyId);

    if (result.changes === 0) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The agent is not assigned to that policy.', {
        details: { agentId, policyId },
      });
    }
  }

  unassignAll(agentId: string): number {
    const result = this.database
      .prepare('DELETE FROM agent_policy_assignments WHERE agent_id = ?')
      .run(agentId);
    return result.changes;
  }

  listPoliciesForAgent(agentId: string): Policy[] {
    const rows = this.database
      .prepare(
        `SELECT p.* FROM policies p
           JOIN agent_policy_assignments a ON a.policy_id = p.id
          WHERE a.agent_id = ?
          ORDER BY p.name`,
      )
      .all(agentId) as PolicyRow[];

    return rows.map(toPolicy);
  }
}

function sortValue(a: Policy, b: Policy, sort: PolicyQuery['sort']): number {
  switch (sort) {
    case 'priority':
      return a.priority - b.priority;
    case 'createdAt':
      return a.createdAt.localeCompare(b.createdAt);
    case 'updatedAt':
      return a.updatedAt.localeCompare(b.updatedAt);
    default:
      return a.name.localeCompare(b.name);
  }
}

/** `%`, `_`, and the escape character are literal in a search term, not wildcards. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
