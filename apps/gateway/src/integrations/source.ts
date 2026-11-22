import { z } from 'zod';

import { idSchema } from '../domain/primitives.js';

/**
 * Where a catalog tool comes from (ADR-048).
 *
 * Two source types, one catalog, one authorization model:
 *
 *  * `mcp_backend`   — a configured MCP backend, the original and still the
 *    primary source. Its `sourceId` is the backend id, and every existing
 *    reader of `CatalogTool.backendId` keeps working.
 *  * `managed_integration` — a managed connector (Phase 12 defines the shape,
 *    no production provider exists). Its `sourceId` is a gateway-generated
 *    connection id.
 *
 * The pair is stable from the moment a tool enters the catalog, so a stored
 * client config (a public tool name) never changes meaning underneath its owner.
 * Ids never cross types: a backend id is never a connection id, which is what
 * makes `sourceType` + `sourceId` a collision-free key without a central
 * sequence.
 */
export const TOOL_SOURCE_TYPES = ['mcp_backend', 'managed_integration'] as const;
export const toolSourceTypeSchema = z.enum(TOOL_SOURCE_TYPES);
export type ToolSourceType = z.infer<typeof toolSourceTypeSchema>;

/**
 * Reference to the thing that can execute a tool.
 *
 * The same shape the router dispatches on (ADR-048): the MCP path keeps its
 * exact behavior because its reference is `{ mcp_backend, backendId }`, and
 * the integration path is `{ managed_integration, connectionId }` — a seam,
 * not a second pipeline.
 */
export const toolSourceRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mcp_backend'), sourceId: idSchema }),
  z.object({ type: z.literal('managed_integration'), sourceId: idSchema }),
]);
export type ToolSourceReference = z.infer<typeof toolSourceRefSchema>;

/** Builds the MCP-backend source reference. Catalog construction uses this so the two shapes cannot drift. */
export function backendSource(backendId: string): ToolSourceReference {
  return { type: 'mcp_backend', sourceId: backendId };
}
