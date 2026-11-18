import { z } from 'zod';

import { idSchema, timestampSchema } from './primitives.js';

/** An agent is a client profile. Credentials are a separate entity. */

export const CLIENT_TYPES = ['claude-code', 'codex-cli', 'opencode', 'deepseek', 'other'] as const;
export const clientTypeSchema = z.enum(CLIENT_TYPES);
export type ClientType = z.infer<typeof clientTypeSchema>;

const agentFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  clientType: clientTypeSchema.optional(),
  enabled: z.boolean().default(true),
};

export const createAgentSchema = z.object(agentFields).strict();

export const updateAgentSchema = z
  .object({
    name: agentFields.name.optional(),
    description: agentFields.description,
    clientType: clientTypeSchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const agentSchema = z
  .object({
    id: idSchema,
    ...agentFields,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    lastSeenAt: timestampSchema.optional(),
  })
  .strict();

export type CreateAgentInput = z.input<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export type Agent = z.infer<typeof agentSchema>;
