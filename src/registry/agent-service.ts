import { randomUUID } from 'node:crypto';

import type { Agent, CreateAgentInput, UpdateAgentInput } from '../domain/agent.js';
import { createAgentSchema, updateAgentSchema } from '../domain/agent.js';
import type { AuditAction } from '../domain/audit-event.js';
import type { AgentPage, AgentQuery } from '../domain/repositories.js';
import type { Database } from '../infrastructure/database/index.js';
import { AppError } from '../shared/errors.js';
import type { Actor } from './backend-service.js';
import { LOCAL_OPERATOR } from './backend-service.js';

/**
 * Agent profiles.
 *
 * Lifecycle rules that span more than one table live here:
 *   * a name is unique among live agents (the partial index enforces it, this
 *     layer turns the collision into a `RESOURCE_CONFLICT`);
 *   * deleting an agent is one transaction: tombstone + revoke every credential +
 *     drop every policy assignment. Audit rows keep pointing at the id, which is
 *     why deletion is a tombstone and not a `DELETE`.
 *
 * Routes only parse and format; the repository only persists.
 */

export interface DeletedAgent {
  agent: Agent;
  /** Credentials revoked by the deletion, for the operator's confirmation message. */
  revokedCredentials: number;
  /** Policy assignments removed by the deletion. */
  removedAssignments: number;
}

export class AgentService {
  constructor(
    private readonly store: Database,
    private readonly actor: Actor = LOCAL_OPERATOR,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(query: AgentQuery): AgentPage {
    return this.store.agents.query(query);
  }

  get(agentId: string): Agent {
    return this.requireAgent(agentId);
  }

  create(input: CreateAgentInput): Agent {
    const parsed = createAgentSchema.parse(input);

    return this.store.transaction(() => {
      const existing = this.store.agents.findByName(parsed.name);
      if (existing !== undefined) {
        throw new AppError('RESOURCE_CONFLICT', 'An agent with that name already exists.', {
          details: { name: parsed.name },
        });
      }

      const agent = this.store.agents.create(parsed, this.now());
      // No policy assignment and no credential: a new agent can do nothing at all
      // until an operator grants both (default deny).
      this.audit('agent.created', 'success', agent, { enabled: agent.enabled });
      return agent;
    });
  }

  update(agentId: string, input: UpdateAgentInput): Agent {
    const parsed = updateAgentSchema.parse(input);

    return this.store.transaction(() => {
      const existing = this.requireAgent(agentId);

      if (parsed.name !== undefined && parsed.name !== existing.name) {
        const clash = this.store.agents.findByName(parsed.name);
        if (clash !== undefined && clash.id !== agentId) {
          throw new AppError('RESOURCE_CONFLICT', 'An agent with that name already exists.', {
            details: { name: parsed.name },
          });
        }
      }

      const updated = this.store.agents.update(agentId, parsed, this.now());
      const changed = changedFields(existing, updated);

      // A PATCH may flip `enabled`; that is an access change, not a profile edit.
      if (existing.enabled !== updated.enabled) {
        this.audit(updated.enabled ? 'agent.enabled' : 'agent.disabled', 'success', updated, {
          via: 'update',
        });
      }

      this.audit('agent.updated', 'success', updated, { changed: changed.join(',') || 'none' });
      return updated;
    });
  }

  /** Idempotent: re-enabling an enabled agent writes no audit row. */
  setEnabled(agentId: string, enabled: boolean): Agent {
    return this.store.transaction(() => {
      const existing = this.requireAgent(agentId);
      if (existing.enabled === enabled) return existing;

      const updated = this.store.agents.update(agentId, { enabled }, this.now());
      this.audit(enabled ? 'agent.enabled' : 'agent.disabled', 'success', updated, {});
      return updated;
    });
  }

  /**
   * Deletes an agent and everything that could still authenticate as it.
   *
   * Order inside the transaction is: tombstone, revoke credentials, drop
   * assignments. After the tombstone the agent cannot be found, so no credential
   * check can succeed even if a revocation were missed.
   */
  remove(agentId: string): DeletedAgent {
    return this.store.transaction(() => {
      const existing = this.requireAgent(agentId);
      const now = this.now();

      this.store.agents.softDelete(agentId, now);
      const revokedCredentials = this.store.credentials.revokeAllForAgent(agentId, now);
      const removedAssignments = this.store.policies.unassignAll(agentId);

      this.audit('agent.deleted', 'success', existing, {
        name: existing.name,
        revokedCredentials,
        removedAssignments,
      });

      return { agent: existing, revokedCredentials, removedAssignments };
    });
  }

  private requireAgent(agentId: string): Agent {
    const agent = this.store.agents.findById(agentId);
    if (agent === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested agent does not exist.', {
        details: { agentId },
      });
    }
    return agent;
  }

  private audit(
    action: AuditAction,
    result: 'success' | 'failure',
    agent: Agent,
    metadata: Record<string, string | number | boolean>,
  ): void {
    this.store.audit.append({
      id: randomUUID(),
      actorType: this.actor.type,
      ...(this.actor.id === undefined ? {} : { actorId: this.actor.id }),
      action,
      targetType: 'agent',
      targetId: agent.id,
      result,
      metadata,
      createdAt: this.now(),
    });
  }
}

/** Public representation. Credentials are never part of an agent payload by construction. */
export function toPublicAgent(agent: Agent): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    ...(agent.description === undefined ? {} : { description: agent.description }),
    ...(agent.clientType === undefined ? {} : { clientType: agent.clientType }),
    enabled: agent.enabled,
    status: agent.enabled ? 'active' : 'disabled',
    ...(agent.metadata === undefined ? {} : { metadata: agent.metadata }),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    ...(agent.lastAuthenticatedAt === undefined ? {} : { lastAuthenticatedAt: agent.lastAuthenticatedAt }),
  };
}

function changedFields(before: Agent, after: Agent): string[] {
  const fields: Array<keyof Agent> = ['name', 'description', 'clientType', 'metadata', 'enabled'];
  return fields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}
