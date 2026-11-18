import { z } from 'zod';

import { idSchema, timestampSchema } from './primitives.js';

/**
 * Access policy contracts. Phase 2 defines the shapes and one deterministic
 * ordering rule; the evaluation engine (allow/deny across backends and tools)
 * is Phase 6.
 *
 * Model: a policy is a named, ordered group of rules. Agents are assigned
 * policies; assignments are many-to-many (`agent_policy_assignments`).
 * Default deny is structural — no matching rule means no access.
 */

export const POLICY_EFFECTS = ['allow', 'deny'] as const;
export const policyEffectSchema = z.enum(POLICY_EFFECTS);
export type PolicyEffect = z.infer<typeof policyEffectSchema>;

/** `*` matches everything at that level; otherwise an exact identifier. */
export const matchTargetSchema = z.string().trim().min(1).max(200);
export const WILDCARD = '*';

export const policyRuleSchema = z
  .object({
    /** `backend` restricts by backend id, `tool` by public tool name. */
    resource: z.enum(['backend', 'tool']),
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
 * Deterministic conflict resolution. Used by the Phase 6 engine; defined here so
 * both the engine and its tests share one rule.
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
