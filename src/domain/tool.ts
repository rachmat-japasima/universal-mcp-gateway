import { z } from 'zod';

import { idSchema, timestampSchema } from './primitives.js';

/**
 * One discovered backend tool, as the gateway understands it.
 *
 * Deliberately *not* the SDK's `Tool` type: `inputSchema`/`outputSchema` are
 * opaque JSON Schema here. The gateway forwards them verbatim (ADR-037), so
 * typing them as a recursive JSON Schema would be a promise it cannot keep for
 * every remote dialect — and a lossy conversion is exactly what must not happen.
 *
 * No executable object ever lives in a catalog record: the live client is looked
 * up by `backendId` at call time.
 */

/** Why a tool is or is not callable. `conflict` and `unavailable` are never routed. */
export const TOOL_AVAILABILITIES = ['available', 'unavailable', 'conflict'] as const;
export const toolAvailabilitySchema = z.enum(TOOL_AVAILABILITIES);
export type ToolAvailability = z.infer<typeof toolAvailabilitySchema>;

export const DISCOVERY_STATUSES = ['never', 'ok', 'failed'] as const;
export const discoveryStatusSchema = z.enum(DISCOVERY_STATUSES);
export type DiscoveryStatus = z.infer<typeof discoveryStatusSchema>;

/** Diagnostic for a tool whose public name was claimed by more than one backend tool. */
export const toolConflictSchema = z
  .object({
    publicName: z.string().min(1).max(128),
    /** Every `backendId`/`originalName` pair that generated it, sorted. */
    claimants: z
      .array(z.object({ backendId: idSchema, originalName: z.string().max(500) }).strict())
      .min(2),
  })
  .strict();
export type ToolConflict = z.infer<typeof toolConflictSchema>;

/**
 * The wire shape of a tool. It is structurally the MCP `Tool` minus nothing:
 * `inputSchema` and `outputSchema` are carried as-is so `tools/list` can
 * re-emit them without a round trip through a schema library.
 */
export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  icons?: unknown[];
}

export interface CatalogTool extends ToolDefinition {
  /** Public name; identical to `ToolDefinition.name`, kept as the routing key. */
  publicName: string;
  originalName: string;
  backendId: string;
  availability: ToolAvailability;
  /** `unavailable`/`conflict` entries carry the reason a client is not offered it. */
  unavailableReason?: string;
  discoveredAt: string;
  updatedAt: string;
}

/** Public, REST-facing view. Same data; the schema exists so additions are explicit. */
export const catalogToolViewSchema = z
  .object({
    publicName: z.string().min(1).max(128),
    originalName: z.string().min(1).max(500),
    backendId: idSchema,
    description: z.string().max(4000).optional(),
    title: z.string().max(500).optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    annotations: z.record(z.string(), z.unknown()).optional(),
    availability: toolAvailabilitySchema,
    unavailableReason: z.string().max(500).optional(),
    discoveredAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type CatalogToolView = z.infer<typeof catalogToolViewSchema>;

export const discoveryReportSchema = z
  .object({
    backendId: idSchema,
    status: discoveryStatusSchema,
    toolCount: z.number().int().min(0),
    conflictCount: z.number().int().min(0),
    rejectedCount: z.number().int().min(0),
    discoveredAt: timestampSchema,
    /** Sanitized failure summary; never a payload or a credential. */
    lastError: z.string().max(500).optional(),
  })
  .strict();
export type DiscoveryReport = z.infer<typeof discoveryReportSchema>;
