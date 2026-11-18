import { Hono } from 'hono';

import { ok } from '../http.js';
import type { BackendService } from '../../registry/backend-service.js';
import { SERVICE_INFO } from '../../core/gateway.js';

/**
 * System endpoints for the management API.
 *
 * These do not replace `/health`: that is the liveness probe and must stay
 * dependency-free. `/api/v1/system` reports management-plane facts a dashboard
 * needs, and deliberately reports counts only — no configuration, no secrets.
 */

export interface SystemDependencies {
  service: BackendService;
  environment: string;
  mcpEndpoint: string;
  healthEndpoint: string;
}

export function systemRoutes(deps: SystemDependencies): Hono {
  const routes = new Hono();

  routes.get('/', (c) => {
    const backends = deps.service.list({
      limit: 1,
      offset: 0,
      sort: 'name',
      order: 'asc',
    });

    return ok(c, {
      service: SERVICE_INFO.name,
      version: SERVICE_INFO.version,
      environment: deps.environment,
      endpoints: { mcp: deps.mcpEndpoint, health: deps.healthEndpoint },
      counts: { backends: backends.total },
      /**
       * Phase 4 connects on explicit request only. There is no tool routing and
       * no authentication yet, so both stay `false` until their phase lands.
       */
      capabilities: { backendConnections: true, toolRouting: false, authentication: false },
    });
  });

  routes.get('/health', (c) =>
    ok(c, { status: 'ok', timestamp: new Date().toISOString() }),
  );

  return routes;
}
