import { z } from 'zod';

import { idSchema, timestampSchema } from './primitives.js';
import { TOOL_SOURCE_TYPES, toolSourceTypeSchema, type ToolSourceType } from '../integrations/source.js';

/**
 * One discovered tool, as the gateway understands it.
 *
 * Deliberately *not* the SDK's `Tool` type: `inputSchema`/`outputSchema` are
 * opaque JSON Schema here. The gateway forwards them verbatim (ADR-037), so
 * typing them as a recursive JSON Schema would be a promise it cannot keep for
 * every remote dialect — and a lossy conversion is exactly what must not happen.
 *
 * No executable object ever lives in a catalog record: the live client or
 * connector is looked up by the *source reference* at call time.
 *
 * Two source variants (ADR-048), discriminated by `sourceType` so the router's
 * dispatch seam is exhaustive by construction — a managed tool literally cannot
 * reach a line of MCP code, and an MCP tool cannot reach a connector:
 *
 *  * `mcp_backend` keeps `backendId` (=== `sourceId`), so every pre-Phase-12
 *    reader keeps compiling and behaving identically.
 *  * `managed_integration` has only `sourceId` (a connection id). No backend
 *    field is fabricated for it: a lying `backendId` would survive into logs
 *    and activity rows.
 */

/** Why a tool is or is not callable. `conflict` and `unavailable` are never routed. */
export const TOOL_AVAILABILITIES = ['available', 'unavailable', 'conflict'] as const;
export const toolAvailabilitySchema = z.enum(TOOL_AVAILABILITIES);
export type ToolAvailability = z.infer<typeof toolAvailabilitySchema>;

export const DISCOVERY_STATUSES = ['never', 'ok', 'failed'] as const;
export const discoveryStatusSchema = z.enum(DISCOVERY_STATUSES);
export type DiscoveryStatus = z.infer<typeof discoveryStatusSchema>;

/**
 * Diagnostic for a tool whose public name was claimed by more than one tool.
 * Claimants identify a *source* (backend id or connection id) plus the original
 * name; `backendId` is kept for MCP claimants so existing API consumers see the
 * exact shape they saw before.
 */
export const toolConflictSchema = z
  .object({
    publicName: z.string().min(1).max(128),
    claimants: z
      .array(
        z
          .object({
            sourceType: toolSourceTypeSchema,
            sourceId: idSchema,
            /** Present iff `sourceType === 'mcp_backend'`, where it equals `sourceId`. */
            backendId: idSchema.optional(),
            originalName: z.string().max(500),
          })
          .strict(),
      )
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

/** Fields every catalog tool carries, regardless of source. */
interface CatalogToolBase extends ToolDefinition {
  /** Public name; identical to `ToolDefinition.name`, kept as the routing key. */
  publicName: string;
  originalName: string;
  availability: ToolAvailability;
  /** `unavailable`/`conflict` entries carry the reason a client is not offered it. */
  unavailableReason?: string;
  discoveredAt: string;
  updatedAt: string;
}

export interface McpCatalogTool extends CatalogToolBase {
  sourceType: 'mcp_backend';
  /** The backend id; doubles as the source id. */
  sourceId: string;
  backendId: string;
}

export interface ManagedCatalogTool extends CatalogToolBase {
  sourceType: 'managed_integration';
  /** The gateway-generated connection id (ADR-048: never account info, never random-suffixed). */
  sourceId: string;
}

export type CatalogTool = McpCatalogTool | ManagedCatalogTool;

/** Type guard for the MCP variant; the seam and readers narrow with this. */
export function isMcpTool(tool: CatalogTool): tool is McpCatalogTool {
  return tool.sourceType === 'mcp_backend';
}

/**
 * Public, REST-facing view. Same data; the schema exists so additions are
 * explicit. `backendId` is optional because managed tools have none.
 */
export const catalogToolViewSchema = z
  .object({
    publicName: z.string().min(1).max(128),
    originalName: z.string().min(1).max(500),
    sourceType: toolSourceTypeSchema,
    sourceId: idSchema,
    backendId: idSchema.optional(),
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

export { TOOL_SOURCE_TYPES, toolSourceTypeSchema };
export type { ToolSourceType };

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
