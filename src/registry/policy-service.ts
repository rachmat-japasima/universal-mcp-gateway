import { randomUUID } from 'node:crypto';

import type { AuditAction } from '../domain/audit-event.js';
import type { CreatePolicyInput, Policy, PolicyRule, UpdatePolicyInput } from '../domain/policy.js';
import { createPolicySchema, policyRuleSchema, updatePolicySchema, WILDCARD } from '../domain/policy.js';
import type { PolicyPage, PolicyQuery } from '../domain/repositories.js';
import type { Database } from '../infrastructure/database/index.js';
import { AppError } from '../shared/errors.js';
import type { Actor } from './backend-service.js';
import { LOCAL_OPERATOR } from './backend-service.js';

/**
 * Policy management.
 *
 * Validation strategy for rule targets, chosen because the two identifier kinds
 * have different lifetimes:
 *   * `backend` targets are checked against the registry — a backend id is
 *     durable, so a policy naming a nonexistent one is a typo worth rejecting.
 *     A soft-deleted backend still resolves, so an old policy stays editable.
 *   * `tool` targets are checked for *shape* only (a well-formed public tool
 *     name), never for existence. The catalog is derived and transient
 *     (ADR-038): a policy must be authorable while a backend is disconnected,
 *     and must not become invalid when a backend is removed.
 */

export interface PolicyServiceOptions {
  store: Database;
  actor?: Actor;
  now?: () => string;
}

/** Public tool names are normalized to this alphabet by the catalog (`SEP-986`). */
const TOOL_TARGET_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export class PolicyService {
  private readonly store: Database;
  private readonly actor: Actor;
  private readonly now: () => string;

  constructor(options: PolicyServiceOptions) {
    this.store = options.store;
    this.actor = options.actor ?? LOCAL_OPERATOR;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  list(query: PolicyQuery): PolicyPage {
    if (query.agentId !== undefined) this.requireAgent(query.agentId);
    // Validate the referenced backend so a typo is `404`, not a silent empty page.
    if (query.backendId !== undefined && this.store.backends.findById(query.backendId) === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested backend does not exist.', {
        details: { backendId: query.backendId },
      });
    }
    return this.store.policies.query(query);
  }

  get(policyId: string): Policy {
    return this.requirePolicy(policyId);
  }

  create(input: CreatePolicyInput): Policy {
    const parsed = createPolicySchema.parse(input);
    this.validateRules(parsed.rules);

    return this.store.transaction(() => {
      const existing = this.store.policies.findByName(parsed.name);
      if (existing !== undefined) {
        throw new AppError('RESOURCE_CONFLICT', 'A policy with that name already exists.', {
          details: { name: parsed.name },
        });
      }

      const policy = this.store.policies.create(parsed, this.now());
      this.audit('policy.created', 'success', policy, { rules: policy.rules.length, priority: policy.priority });
      return policy;
    });
  }

  update(policyId: string, input: UpdatePolicyInput): Policy {
    const parsed = updatePolicySchema.parse(input);
    if (parsed.rules !== undefined) this.validateRules(parsed.rules);

    return this.store.transaction(() => {
      const existing = this.requirePolicy(policyId);

      if (parsed.name !== undefined && parsed.name !== existing.name) {
        const clash = this.store.policies.findByName(parsed.name);
        if (clash !== undefined && clash.id !== policyId) {
          throw new AppError('RESOURCE_CONFLICT', 'A policy with that name already exists.', {
            details: { name: parsed.name },
          });
        }
      }

      const updated = this.store.policies.update(policyId, parsed, this.now());
      this.audit('policy.updated', 'success', updated, { rules: updated.rules.length, priority: updated.priority });
      return updated;
    });
  }

  /**
   * Hard delete, per ADR-024: an assignment is a grant, not history. Removing a
   * policy immediately withdraws every grant it carried, which is the safe
   * direction to fail.
   */
  remove(policyId: string): Policy {
    return this.store.transaction(() => {
      const existing = this.requirePolicy(policyId);
      this.store.policies.delete(policyId);
      this.audit('policy.deleted', 'success', existing, { name: existing.name });
      return existing;
    });
  }

  /** Assigning an already-assigned policy is idempotent at the API level. */
  assign(agentId: string, policyId: string): Policy {
    return this.store.transaction(() => {
      this.requireAgent(agentId);
      const policy = this.requirePolicy(policyId);

      const already = this.store.policies
        .listPoliciesForAgent(agentId)
        .some((assigned) => assigned.id === policyId);

      if (!already) {
        this.store.policies.assign(agentId, policyId, this.now());
        this.audit('policy.assigned', 'success', policy, { agentId, policyId });
      }

      return policy;
    });
  }

  unassign(agentId: string, policyId: string): Policy {
    return this.store.transaction(() => {
      this.requireAgent(agentId);
      const policy = this.requirePolicy(policyId);

      this.store.policies.unassign(agentId, policyId);
      this.audit('policy.unassigned', 'success', policy, { agentId, policyId });
      return policy;
    });
  }

  /**
   * Rejects a rule that can never be evaluated as written.
   *
   * A wildcard is always valid. Otherwise a backend id must exist, and a tool
   * target must be a name the catalog could produce.
   */
  private validateRules(rules: readonly PolicyRule[]): void {
    rules.forEach((rule, index) => {
      const parsed = policyRuleSchema.safeParse(rule);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', `Rule ${index} is invalid.`, {
          details: { rule: index },
        });
      }

      if (rule.target === WILDCARD) return;

      if (rule.resource === 'backend' && this.store.backends.findById(rule.target) === undefined) {
        throw new AppError('VALIDATION_ERROR', `Rule ${index} names a backend that does not exist.`, {
          details: { rule: index, resource: 'backend' },
        });
      }

      if (rule.resource === 'tool' && !TOOL_TARGET_PATTERN.test(rule.target)) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Rule ${index} is not a well-formed public tool name (letters, digits, dot, underscore, hyphen; max 128).`,
          { details: { rule: index, resource: 'tool' } },
        );
      }
    });
  }

  private requireAgent(agentId: string): void {
    if (this.store.agents.findById(agentId) === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested agent does not exist.', {
        details: { agentId },
      });
    }
  }

  private requirePolicy(policyId: string): Policy {
    const policy = this.store.policies.findById(policyId);
    if (policy === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested policy does not exist.', {
        details: { policyId },
      });
    }
    return policy;
  }

  private audit(
    action: AuditAction,
    result: 'success',
    policy: Policy,
    metadata: Record<string, string | number | boolean>,
  ): void {
    this.store.audit.append({
      id: randomUUID(),
      actorType: this.actor.type,
      ...(this.actor.id === undefined ? {} : { actorId: this.actor.id }),
      action,
      targetType: 'policy',
      targetId: policy.id,
      result,
      metadata,
      createdAt: this.now(),
    });
  }
}

export function toPublicPolicy(policy: Policy): Record<string, unknown> {
  return {
    id: policy.id,
    name: policy.name,
    ...(policy.description === undefined ? {} : { description: policy.description }),
    priority: policy.priority,
    rules: policy.rules,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}
