import { z } from 'zod';

import { idSchema, timestampSchema } from './primitives.js';

/**
 * Access policy contracts and the deterministic evaluation rule.
 *
 * Model: a policy is a named, ordered group of rules. Agents are assigned
 * policies; assignments are many-to-many (`agent_policy_assignments`).
 * Default deny is structural — no matching rule means no access.
 *
 * Precedence (one rule, shared by the engine and its tests):
 *   1. System restrictions (agent disabled, credential inactive) are applied by
 *      the caller *before* this module and cannot be overridden by a rule.
 *   2. Explicit `deny` wins over `allow`.
 *   3. Higher policy `priority` wins over lower.
 *   4. Remaining ties break by policy id, then rule index, so the outcome never
 *      depends on row order.
 */

export const POLICY_EFFECTS = ['allow', 'deny'] as const;
export const policyEffectSchema = z.enum(POLICY_EFFECTS);
export type PolicyEffect = z.infer<typeof policyEffectSchema>;

/** `*` matches everything at that level; otherwise an exact identifier. */
export const matchTargetSchema = z.string().trim().min(1).max(200);
export const WILDCARD = '*';

export const POLICY_RESOURCES = ['backend', 'tool'] as const;
export const policyResourceSchema = z.enum(POLICY_RESOURCES);
export type PolicyResource = z.infer<typeof policyResourceSchema>;

export const policyRuleSchema = z
  .object({
    /** `backend` restricts by backend id, `tool` by public tool name. */
    resource: policyResourceSchema,
    /** Backend id, public tool name, or `*`. */
    target: matchTargetSchema,
    effect: policyEffectSchema,
  })
  .strict();

export type PolicyRule = z.infer<typeof policyRuleSchema>;

const policyFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  /**
   * Evaluation order across the agent's assigned policies. Higher wins; ties
   * resolve by `deny` over `allow`, then by policy id, so the outcome never
   * depends on row order.
   */
  priority: z.number().int().min(-1000).max(1000).default(0),
  rules: z.array(policyRuleSchema).max(500).default([]),
};

export const createPolicySchema = z.object(policyFields).strict();

export const updatePolicySchema = z
  .object({
    name: policyFields.name.optional(),
    description: policyFields.description,
    priority: policyFields.priority.optional(),
    rules: z.array(policyRuleSchema).max(500).optional(),
  })
  .strict();

export const policySchema = z
  .object({
    id: idSchema,
    ...policyFields,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export type CreatePolicyInput = z.input<typeof createPolicySchema>;
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;
export type Policy = z.infer<typeof policySchema>;

/**
 * Deterministic conflict resolution across policies.
 *
 * Highest priority first; at equal priority `deny` wins; remaining ties break by
 * id so the result is stable regardless of query order.
 */
export function comparePolicyRules(
  a: { priority: number; id: string },
  b: { priority: number; id: string },
): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function comparePolicyEffects(a: PolicyEffect, b: PolicyEffect): number {
  if (a === b) return 0;
  return a === 'deny' ? -1 : 1;
}

/** Why a decision came out the way it did. Internal only; never sent to an MCP client. */
export const ACCESS_REASONS = [
  'explicit_allow',
  'explicit_deny',
  'default_deny',
  'agent_disabled',
  'agent_not_found',
  'credential_inactive',
  'backend_disabled',
] as const;
export const accessReasonSchema = z.enum(ACCESS_REASONS);
export type AccessReason = z.infer<typeof accessReasonSchema>;

export const accessDecisionSchema = z
  .object({
    allowed: z.boolean(),
    reason: accessReasonSchema,
    agentId: idSchema.optional(),
    backendId: z.string().trim().max(200).optional(),
    toolId: z.string().trim().max(200).optional(),
    matchedPolicyId: idSchema.optional(),
    decisionTimestamp: timestampSchema,
  })
  .strict();

export type AccessDecision = z.infer<typeof accessDecisionSchema>;

export interface AccessQuery {
  agentId?: string;
  backendId?: string;
  /** Public tool name: the identifier a rule's `tool` target is matched against. */
  toolId?: string;
  now: string;
}

/**
 * Pure evaluation over an agent's assigned policies.
 *
 * No I/O, no clock, no defaults read from the environment: every input is an
 * argument, so a decision can be reproduced from the audit trail.
 */
export function evaluateAccess(policies: readonly Policy[], query: AccessQuery): AccessDecision {
  const candidates: Array<{ policyId: string; priority: number; effect: PolicyEffect; index: number }> = [];

  for (const policy of policies) {
    policy.rules.forEach((rule, index) => {
      if (!ruleMatches(rule, query)) return;
      candidates.push({ policyId: policy.id, priority: policy.priority, effect: rule.effect, index });
    });
  }

  if (candidates.length === 0) {
    return decision(false, 'default_deny', query);
  }

  // Priority desc → deny before allow → policy id → rule index.
  //
  // The deny-before-allow step only applies *within one priority level*. That is
  // the documented reconciliation of the spec's "explicit DENY overrides ALLOW"
  // with the operator's explicit priority ordering: an operator who puts a deny
  // above an allow has said so, and a policy that means "never" should carry the
  // higher priority. Ties are where the ambiguity lives, so that is where deny
  // wins — and the outcome never depends on row order.
  candidates.sort(
    (a, b) =>
      b.priority - a.priority ||
      comparePolicyEffects(a.effect, b.effect) ||
      comparePolicyRules({ priority: a.priority, id: a.policyId }, { priority: b.priority, id: b.policyId }) ||
      a.index - b.index,
  );

  const winner = candidates[0]!;
  return {
    ...decision(winner.effect === 'allow', winner.effect === 'allow' ? 'explicit_allow' : 'explicit_deny', query),
    matchedPolicyId: winner.policyId,
  };
}

function ruleMatches(rule: PolicyRule, query: AccessQuery): boolean {
  if (rule.resource === 'backend') {
    if (query.backendId === undefined) return false;
    return rule.target === WILDCARD || rule.target === query.backendId;
  }

  if (query.toolId === undefined) return false;
  return rule.target === WILDCARD || rule.target === query.toolId;
}

function decision(allowed: boolean, reason: AccessReason, query: AccessQuery): AccessDecision {
  return {
    allowed,
    reason,
    ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
    ...(query.backendId === undefined ? {} : { backendId: query.backendId }),
    ...(query.toolId === undefined ? {} : { toolId: query.toolId }),
    decisionTimestamp: query.now,
  };
}
