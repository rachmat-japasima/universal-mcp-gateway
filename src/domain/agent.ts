import { z } from 'zod';

import { idSchema, timestampSchema } from './primitives.js';

/**
 * An agent is a client profile. Credentials are a separate entity.
 *
 * `enabled` is the stored switch; `status` is derived from it (ADR-025), so the
 * two can never disagree.
 */

/**
 * Known client identifiers.
 *
 * A closed list on purpose: this value is operator-visible metadata and is used
 * only for display and filtering — never as an authorization input. Adding a new
 * client is one line here plus its entry in `docs/BACKEND_SPEC.md`; `other` is
 * the escape hatch so an unknown client is never blocked from connecting.
 */
export const CLIENT_TYPES = [
  'claude-code',
  'codex-cli',
  'opencode',
  'deepseek',
  'deepseek-desktop',
  'other',
] as const;
export const clientTypeSchema = z.enum(CLIENT_TYPES);
export type ClientType = z.infer<typeof clientTypeSchema>;

export const AGENT_STATUSES = ['active', 'disabled'] as const;
export const agentStatusSchema = z.enum(AGENT_STATUSES);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/**
 * Keys an agent may not set through `metadata`.
 *
 * Metadata is a free-form operator annotation. A key naming a field the gateway
 * enforces would make the annotation a second, unchecked source of truth, so it
 * is rejected rather than silently ignored.
 */
export const RESERVED_METADATA_KEYS: readonly string[] = [
  'id',
  'agentId',
  'enabled',
  'status',
  'clientType',
  'createdAt',
  'updatedAt',
  'lastAuthenticatedAt',
  'deletedAt',
  'policyIds',
  'credentialHash',
  'token',
];

export const agentMetadataSchema = z
  .record(z.string().trim().min(1).max(64), z.union([z.string().max(500), z.number(), z.boolean()]))
  .refine((metadata) => Object.keys(metadata).length <= 20, {
    message: 'Agent metadata may have at most 20 entries',
  })
  .refine((metadata) => !Object.keys(metadata).some((key) => RESERVED_METADATA_KEYS.includes(key)), {
    message: 'Agent metadata may not set a reserved field',
  });

export type AgentMetadata = z.infer<typeof agentMetadataSchema>;

const agentFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  clientType: clientTypeSchema.optional(),
  metadata: agentMetadataSchema.optional(),
  enabled: z.boolean().default(true),
};

export const createAgentSchema = z.object(agentFields).strict();

export const updateAgentSchema = z
  .object({
    name: agentFields.name.optional(),
    description: agentFields.description,
    clientType: clientTypeSchema.nullable().optional(),
    /** Replaces the whole map; there is no partial metadata merge. */
    metadata: agentMetadataSchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const agentSchema = z
  .object({
    id: idSchema,
    ...agentFields,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    /** Set the first time a credential of this agent authenticates. */
    lastAuthenticatedAt: timestampSchema.optional(),
  })
  .strict();

export type CreateAgentInput = z.input<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export type Agent = z.infer<typeof agentSchema>;

/** Derived, never stored: a stored status can contradict `enabled` after a partial write. */
export function agentStatus(agent: Pick<Agent, 'enabled'>): AgentStatus {
  return agent.enabled ? 'active' : 'disabled';
}
