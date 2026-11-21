import { request } from './client';
import type { IntegrationConnection, IntegrationProvider, IntegrationTool } from './types';

/**
 * Managed-integration read endpoints (Phase 13, ADR-053).
 *
 * One function per documented route — `docs/API_REFERENCE.md` § "Integrations"
 * and `src/api/routes/integrations.routes.ts`. Two facts shape this module:
 *
 *  * **Connections are a plain array, not a page.** The gateway lists them
 *    newest-first without pagination, so `request` (not `requestPage`) is the
 *    honest shape — a `totalPages` here would be invented.
 *  * **Nothing here writes.** Storing a credential, testing one, and the
 *    lifecycle actions are operator writes from client components, which go
 *    through the same-origin write proxy (`send`), never this module.
 */

export const listProviders = (): Promise<IntegrationProvider[]> =>
  request<IntegrationProvider[]>('/api/v1/integrations/providers');

export const listConnections = (): Promise<IntegrationConnection[]> =>
  request<IntegrationConnection[]>('/api/v1/integrations/connections');

export const getConnection = (connectionId: string): Promise<IntegrationConnection> =>
  request<IntegrationConnection>(`/api/v1/integrations/connections/${connectionId}`);

export const listConnectionTools = (connectionId: string): Promise<IntegrationTool[]> =>
  request<IntegrationTool[]>(`/api/v1/integrations/connections/${connectionId}/tools`);
