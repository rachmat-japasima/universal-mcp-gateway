import { z } from 'zod';

import { idSchema, timestampSchema } from './primitives.js';

/**
 * Runtime condition of a backend. Deliberately separate from `Backend`: the
 * configuration can exist while nothing is connected, so a persisted backend
 * must never imply a live connection.
 */

export const BACKEND_STATUSES = [
  'disconnected',
  'connecting',
  'connected',
  'unhealthy',
  'error',
  'disabled',
] as const;

export const backendStatusSchema = z.enum(BACKEND_STATUSES);
export type BackendStatus = z.infer<typeof backendStatusSchema>;

export const backendErrorCodeSchema = z.enum([
  'BACKEND_CONNECTION_ERROR',
  'BACKEND_TIMEOUT',
  'BACKEND_UNAVAILABLE',
]);

/**
 * Sanitized for display. Connection details (URLs, commands, env) are written to
 * logs, never into runtime state that the dashboard renders.
 */
export const lastErrorMessageSchema = z.string().trim().max(500);

export const backendRuntimeSchema = z
  .object({
    backendId: idSchema,
    status: backendStatusSchema,
    lastConnectedAt: timestampSchema.optional(),
    lastHealthCheckAt: timestampSchema.optional(),
    lastErrorCode: backendErrorCodeSchema.optional(),
    lastErrorAt: timestampSchema.optional(),
    lastErrorMessage: lastErrorMessageSchema.optional(),
    /** Bounded to keep a crash-looping backend from overflowing the column. */
    reconnectAttempts: z.number().int().min(0).max(1_000_000).default(0),
    updatedAt: timestampSchema,
  })
  .strict();

export type BackendRuntime = z.infer<typeof backendRuntimeSchema>;

/** Runtime state a new backend starts in; `disabled` mirrors `backend.enabled === false`. */
export function initialBackendRuntime(backendId: string, enabled: boolean, now: string): BackendRuntime {
  return {
    backendId,
    status: enabled ? 'disconnected' : 'disabled',
    reconnectAttempts: 0,
    updatedAt: now,
  };
}
