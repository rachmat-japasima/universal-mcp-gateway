import { z } from 'zod';

import { idSchema, timestampSchema } from './primitives.js';

/**
 * Operational history. Answers "what did the gateway do?".
 *
 * Audit events (see `audit-event.ts`) answer "who changed what?". They are
 * separate tables with separate retention because operational volume is high and
 * administrative history must not be diluted by it.
 *
 * Never store tool arguments or results here (SECURITY.md §9).
 */

export const ACTIVITY_TYPES = [
  'mcp.initialize',
  'tools.list',
  'tools.call',
  'backend.connected',
  'backend.disconnected',
  'backend.error',
  'request.failed',
] as const;

export const activityTypeSchema = z.enum(ACTIVITY_TYPES);
export type ActivityType = z.infer<typeof activityTypeSchema>;

export const ACTIVITY_OUTCOMES = ['success', 'failure', 'denied'] as const;
export const activityOutcomeSchema = z.enum(ACTIVITY_OUTCOMES);
export type ActivityOutcome = z.infer<typeof activityOutcomeSchema>;

export const activityEventSchema = z
  .object({
    id: idSchema,
    type: activityTypeSchema,
    requestId: z.string().trim().max(64).optional(),
    /**
     * Groups one client task across requests. Client-supplied and validated
     * (bounded shape) at the boundary; never used as a lookup key for
     * anything security-relevant.
     */
    correlationId: z.string().trim().max(64).optional(),
    agentId: idSchema.optional(),
    backendId: idSchema.optional(),
    toolName: z.string().trim().max(200).optional(),
    outcome: activityOutcomeSchema,
    /** Stable `ErrorCode`; not a free-form message. */
    errorCode: z.string().trim().max(64).optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
    createdAt: timestampSchema,
  })
  .strict();

export type ActivityEvent = z.infer<typeof activityEventSchema>;
