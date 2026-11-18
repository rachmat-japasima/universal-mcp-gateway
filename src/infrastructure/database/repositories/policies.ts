import { randomUUID } from 'node:crypto';

import type { CreatePolicyInput, Policy, UpdatePolicyInput } from '../../../domain/policy.js';
import { createPolicySchema, policySchema, updatePolicySchema } from '../../../domain/policy.js';
import type { PolicyRepository } from '../../../domain/repositories.js';
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

  list(): Policy[] {
    const rows = this.database.prepare('SELECT * FROM policies ORDER BY name').all() as PolicyRow[];
    return rows.map(toPolicy);
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
