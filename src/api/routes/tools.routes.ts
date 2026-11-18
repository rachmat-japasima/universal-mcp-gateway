import { Hono } from 'hono';
import { z } from 'zod';

import type { CatalogTool, DiscoveryReport } from '../../domain/tool.js';
import type { Logger } from '../../monitoring/logger.js';
import type { ToolCatalog } from '../../routing/catalog.js';
import type { ToolDiscovery } from '../../routing/discovery.js';
import { AppError, formatZodIssues } from '../../shared/errors.js';
import { getRequestId, ok, parseQuery } from '../http.js';
import { backendIdParamSchema } from '../schemas/queries.js';

/**
 * Tool catalog routes.
 *
 * Read-only apart from the two refresh endpoints. There is deliberately no
 * *invocation* endpoint: a tool call goes through `/mcp`, where the protocol's
 * result and error shapes apply. A REST "test call" would need its own authz
 * model and its own result contract, and Phase 5 has neither.
 *
 * Mounted under `/api/v1`, so `/tools` and `/backends/:backendId/tools` are
 * declared by two separate routers to keep the literal-before-parameter rule
 * inside each.
 */

const MAX_PAGE_SIZE = 100;

const publicNameParamSchema = z.object({ publicName: z.string().trim().min(1).max(128) });

const listToolsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
    /** Case-insensitive substring match on the public or original name. */
    search: z.string().trim().min(1).max(200).optional(),
    backendId: z.uuid().optional(),
    availability: z.enum(['available', 'unavailable', 'conflict']).optional(),
    sort: z.enum(['publicName', 'backendId', 'discoveredAt']).default('publicName'),
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  .transform(({ page, limit, ...rest }) => ({ ...rest, limit, offset: (page - 1) * limit, page }));

const backendToolsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
    search: z.string().trim().min(1).max(200).optional(),
  })
  .transform(({ page, limit, ...rest }) => ({ ...rest, limit, offset: (page - 1) * limit, page }));

/** Public view of a catalog tool. `unavailableReason` is already sanitized by the catalog. */
function toView(tool: CatalogTool): Record<string, unknown> {
  return {
    publicName: tool.publicName,
    originalName: tool.originalName,
    backendId: tool.backendId,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    availability: tool.availability,
    ...(tool.unavailableReason === undefined ? {} : { unavailableReason: tool.unavailableReason }),
    discoveredAt: tool.discoveredAt,
    updatedAt: tool.updatedAt,
  };
}

function toReportView(report: DiscoveryReport): Record<string, unknown> {
  return { ...report };
}

function paginate<T>(items: T[], limit: number, offset: number, page: number) {
  const total = items.length;
  return {
    items: items.slice(offset, offset + limit),
    pagination: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) },
  };
}

function parseParam<T>(schema: z.ZodType<T>, value: unknown, requestId: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AppError('VALIDATION_ERROR', formatZodIssues(parsed.error) ?? 'The route parameter is invalid.', {
    requestId,
  });
}

export interface ToolsRouteDependencies {
  catalog: ToolCatalog;
  discovery: ToolDiscovery;
  logger: Logger;
}

export function toolsRoutes(deps: ToolsRouteDependencies): Hono {
  const { catalog, discovery, logger } = deps;
  const routes = new Hono();

  routes.get('/', (c) => {
    const query = parseQuery(c, listToolsQuerySchema);

    const matching = catalog.listAll().filter((tool) => {
      if (query.backendId !== undefined && tool.backendId !== query.backendId) return false;
      if (query.availability !== undefined && tool.availability !== query.availability) return false;
      if (query.search !== undefined) {
        const needle = query.search.toLowerCase();
        const haystack = `${tool.publicName} ${tool.originalName}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });

    const sorted = [...matching].sort((a, b) => {
      const direction = query.order === 'asc' ? 1 : -1;
      const left = sortKey(a, query.sort);
      const right = sortKey(b, query.sort);
      // Public name is the tiebreak for every sort, so paging is stable.
      return left.localeCompare(right) * direction || a.publicName.localeCompare(b.publicName);
    });

    const { items, pagination } = paginate(sorted, query.limit, query.offset, query.page);
    return ok(c, items.map(toView), { pagination });
  });

  /** Discovery reports, i.e. what the last refresh per backend produced. */
  routes.get('/discovery', (c) => ok(c, catalog.reports().map(toReportView)));

  /** Name collisions currently withholding tools. Explicit, never inferred from ordering. */
  routes.get('/conflicts', (c) => ok(c, catalog.conflicts$()));

  /** Refreshes every eligible backend. Failures are reported per backend, not thrown. */
  routes.post('/refresh', async (c) => {
    const results = await discovery.discoverAll({ requestId: getRequestId(c) });

    for (const result of results) {
      if (!result.ok) {
        logger.warn(
          { backendId: result.backendId, code: result.error?.code, requestId: getRequestId(c) },
          'Manual tool refresh failed for a backend',
        );
      }
    }

    return ok(c, {
      refreshed: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      results: results.map((result) => ({
        backendId: result.backendId,
        ok: result.ok,
        ...(result.report === undefined ? {} : { report: toReportView(result.report) }),
        ...(result.error === undefined ? {} : { error: result.error.toEnvelope().error }),
      })),
    });
  });

  routes.get('/:publicName', (c) => {
    const { publicName } = parseParam(publicNameParamSchema, c.req.param(), getRequestId(c));

    const tool = catalog.listAll().find((candidate) => candidate.publicName === publicName);
    if (tool === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested tool does not exist.', {
        details: { publicName },
      });
    }

    return ok(c, toView(tool));
  });

  return routes;
}

export function backendToolsRoutes(deps: ToolsRouteDependencies): Hono {
  const { catalog, discovery } = deps;
  const routes = new Hono();

  /**
   * Nested under `/backends/:backendId`, so this router only declares the
   * `/tools` tail. `backendId` is validated by the parent route's param schema
   * via `c.req.param()` — Hono keeps parent params visible in sub-apps mounted
   * with `route()`, so a missing id would be a wiring bug, not a client error.
   */
  routes.get('/', (c) => {
    const { backendId } = parseParam(backendIdParamSchema, c.req.param(), getRequestId(c));
    const query = parseQuery(c, backendToolsQuerySchema);

    const tools = catalog.listByBackend(backendId).filter((tool) => {
      if (query.search === undefined) return true;
      const needle = query.search.toLowerCase();
      return `${tool.publicName} ${tool.originalName}`.toLowerCase().includes(needle);
    });

    const { items, pagination } = paginate(tools, query.limit, query.offset, query.page);
    const report = catalog.reportFor(backendId);

    return ok(c, items.map(toView), {
      pagination,
      ...(report === undefined ? {} : { discovery: toReportView(report) }),
    });
  });

  routes.post('/refresh', async (c) => {
    const { backendId } = parseParam(backendIdParamSchema, c.req.param(), getRequestId(c));
    const result = await discovery.discover(backendId, { requestId: getRequestId(c) });

    if (!result.ok) {
      // A refresh that could not run is a real failure of the request: the
      // operator asked for a catalog and there is none. The error is an
      // `AppError`, so the shared handler maps it consistently.
      throw result.error ?? new AppError('INTERNAL_ERROR', 'The tool refresh failed.');
    }

    return ok(c, {
      backendId,
      refreshed: true,
      ...(result.report === undefined ? {} : { discovery: toReportView(result.report) }),
    });
  });

  return routes;
}

function sortKey(tool: CatalogTool, sort: 'publicName' | 'backendId' | 'discoveredAt'): string {
  return sort === 'backendId' ? tool.backendId : sort === 'discoveredAt' ? tool.discoveredAt : tool.publicName;
}
