import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';

import { z } from 'zod';

import type { IntegrationConnection } from '../../integrations/connection.js';
import { connectionMetadataSchema } from '../../integrations/connection.js';
import type { IntegrationService } from '../../integrations/service.js';
import type { ProviderRegistry } from '../../integrations/registry.js';
import { providerIdSchema } from '../../integrations/provider.js';
import type { CatalogTool, ToolDefinition } from '../../domain/tool.js';
import type { ToolCatalog } from '../../routing/catalog.js';
import type { AuthenticatedOperator } from '../../registry/operator-service.js';
import type { Actor } from '../../registry/backend-service.js';
import { AppError, formatZodIssues } from '../../shared/errors.js';
import { currentOperator } from '../middleware/operator-auth.js';
import { getRequestId, ok, readJson } from '../http.js';
import { connectionIdParamSchema } from '../schemas/queries.js';

/**
 * Managed-integration routes (Phase 12 read-only, Phase 13 write API).
 *
 * Each handler does exactly three things: parse, call the service, format.
 * Writes audit through the service, which is the only place the audit
 * vocabulary lives; the PAT route is the one place a secret appears in an
 * argument, and it answers with the connection view — a vault reference,
 * never the value, the same as every other response here.
 *
 * `test` and `enable` both run the verification handshake, and mean different
 * things: `test` answers a question (no row change), `enable` commits the
 * connection (the only path to `connected`).
 */

export interface IntegrationRouteDependencies {
  registry: ProviderRegistry;
  integrations: IntegrationService;
  catalog: ToolCatalog;
}

function parseParam<T>(schema: z.ZodType<T>, value: unknown, requestId: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new AppError('VALIDATION_ERROR', formatZodIssues(parsed.error) ?? 'The route parameter is invalid.', {
    requestId,
  });
}

/** The create body: the id is gateway-generated, never client-chosen. */
const createConnectionApiSchema = z
  .object({
    providerId: providerIdSchema,
    name: z.string().trim().min(1).max(100),
    metadata: connectionMetadataSchema.optional(),
  })
  .strict();

/** A credential write: the value exists in this argument and the vault only. */
const storeCredentialApiSchema = z
  .object({
    token: z.string().min(1).max(4_096),
  })
  .strict();

function toProviderView(provider: ReturnType<ProviderRegistry['list']>[number]): Record<string, unknown> {
  return {
    id: provider.id,
    name: provider.name,
    description: provider.description,
    capabilities: provider.capabilities,
    ...(Object.keys(provider.metadata).length === 0 ? {} : { metadata: provider.metadata }),
    registeredAt: provider.registeredAt,
  };
}

function toConnectionView(connection: IntegrationConnection, registry: ProviderRegistry): Record<string, unknown> {
  const provider = registry.get(connection.providerId);
  return {
    id: connection.id,
    providerId: connection.providerId,
    // A connection row survives a provider being unregistered; the view says
    // so instead of pretending the provider never existed.
    ...(provider === undefined ? {} : { providerName: provider.definition.name }),
    name: connection.name,
    status: connection.status,
    credentialId: connection.credentialId,
    metadata: connection.metadata,
    validatedAt: connection.validatedAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

/**
 * Mirrors the tool view in `tools.routes.ts` deliberately rather than sharing
 * a helper: the two files are separate route surfaces, and a shared mapper
 * would couple a change in one response shape to the other's tests.
 */
function toToolView(tool: CatalogTool): Record<string, unknown> {
  return {
    publicName: tool.publicName,
    originalName: tool.originalName,
    sourceType: tool.sourceType,
    sourceId: tool.sourceId,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    availability: tool.availability,
    discoveredAt: tool.discoveredAt,
    updatedAt: tool.updatedAt,
  };
}

export function integrationsRoutes(deps: IntegrationRouteDependencies): Hono {
  const { registry, integrations, catalog } = deps;
  const routes = new Hono();

  /** Every mutation is attributed to the authenticated operator, not a label. */
  const actor = (c: Parameters<typeof currentOperator>[0]): Actor => {
    const identity: AuthenticatedOperator = currentOperator(c);
    return { type: 'admin', id: identity.operator.id };
  };

  /** Registered providers: code-registered (ADR-050), GitHub ships (ADR-053). */
  routes.get('/providers', (c) => ok(c, registry.list().map(toProviderView)));

  routes.get('/connections', (c) => {
    const connections = integrations.list();
    return ok(c, connections.map((connection) => toConnectionView(connection, registry)));
  });

  routes.post('/connections', async (c) => {
    const body = await readJson(c, createConnectionApiSchema);
    // `pending`: the row exists, nothing is verified, nothing is callable.
    const created = integrations.create(
      { id: randomUUID(), ...body, metadata: body.metadata ?? {} },
      actor(c),
    );
    return ok(c, toConnectionView(created, registry), {}, 201);
  });

  routes.get('/connections/:connectionId', (c) => {
    const { connectionId } = parseParam(connectionIdParamSchema, c.req.param(), getRequestId(c));
    return ok(c, toConnectionView(integrations.get(connectionId), registry));
  });

  routes.delete('/connections/:connectionId', (c) => {
    const { connectionId } = parseParam(connectionIdParamSchema, c.req.param(), getRequestId(c));

    // The view of what was removed, captured first: hard delete answers with
    // what is gone rather than a bare acknowledgement.
    const removed = toConnectionView(integrations.get(connectionId), registry);
    integrations.remove(connectionId, actor(c));
    return ok(c, removed);
  });

  /**
   * Stores (or replaces) the credential. Write-only by construction: the
   * response is the connection view, whose only credential-adjacent field is
   * a vault reference. A replacement deletes the previous envelope in the same
   * transaction (ADR-051), so no second readable secret survives.
   */
  routes.post('/connections/:connectionId/credential', async (c) => {
    const { connectionId } = parseParam(connectionIdParamSchema, c.req.param(), getRequestId(c));
    const body = await readJson(c, storeCredentialApiSchema);

    integrations.storeCredential(connectionId, body.token, actor(c));
    return ok(c, toConnectionView(integrations.get(connectionId), registry));
  });

  /**
   * Runs the handshake without moving the row. The refusal shapes arrive as
   * `200` data — the operator's next step depends on the `kind`.
   */
  routes.post('/connections/:connectionId/test', async (c) => {
    const { connectionId } = parseParam(connectionIdParamSchema, c.req.param(), getRequestId(c));
    return ok(c, await integrations.verify(connectionId));
  });

  /**
   * The one path to `connected`: handshake, tool publication, and the
   * `validatedAt` stamp. Also the re-enable from `disabled` and the reconnect
   * from `disconnected` — one explicit operator action, never automatic.
   */
  routes.post('/connections/:connectionId/enable', async (c) => {
    const { connectionId } = parseParam(connectionIdParamSchema, c.req.param(), getRequestId(c));

    const { connection, outcome } = await integrations.connect(connectionId, actor(c));
    return ok(c, {
      connection: toConnectionView(connection, registry),
      tools: outcome,
    });
  });

  /** Tools stay published; the row survives; reconnect is `enable`. */
  routes.post('/connections/:connectionId/disconnect', (c) => {
    const { connectionId } = parseParam(connectionIdParamSchema, c.req.param(), getRequestId(c));
    return ok(c, toConnectionView(integrations.disconnect(connectionId, actor(c)), registry));
  });

  /** Withdraws the tools in the same instant; the row survives, dark. */
  routes.post('/connections/:connectionId/disable', (c) => {
    const { connectionId } = parseParam(connectionIdParamSchema, c.req.param(), getRequestId(c));
    return ok(c, toConnectionView(integrations.disable(connectionId, actor(c)), registry));
  });

  /** The tools this connection publishes, in the catalog's own vocabulary. */
  routes.get('/connections/:connectionId/tools', (c) => {
    const { connectionId } = parseParam(connectionIdParamSchema, c.req.param(), getRequestId(c));
    // Existence first: a typo'd id must be a 404, not an honest-looking `[]`.
    integrations.get(connectionId);
    return ok(c, catalog.listByConnection(connectionId).map(toToolView));
  });

  return routes;
}
