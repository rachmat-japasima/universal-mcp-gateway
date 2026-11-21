import { request, requestPage } from './client';
import type { DiscoveryReport, Page, Tool, ToolConflict, ToolQuery } from './types';

/**
 * Tool catalog endpoints (Phase 10.2).
 *
 * One function per documented route — `docs/API_REFERENCE.md` §3.4 and
 * `src/api/routes/tools.routes.ts`. Two facts shape this module:
 *
 *  * **There is no invocation route.** A tool call goes through `/mcp` under the
 *    agent's own policy, so this module cannot offer a "test call" and the pages
 *    do not pretend to.
 *  * **A tool is addressed by its public name.** `GET /tools/:publicName` takes
 *    the namespaced routing name, not an internal id, so a URL parameter is a
 *    name and must be encoded when it appears in a path.
 */

export const listTools = (query: ToolQuery = {}): Promise<Page<Tool>> =>
  requestPage<Tool>('/api/v1/tools', { ...query });

export const getTool = (publicName: string): Promise<Tool> =>
  request<Tool>(`/api/v1/tools/${encodeURIComponent(publicName)}`);

/** What the last discovery produced, per backend. */
export const getDiscoveryReports = (): Promise<DiscoveryReport[]> =>
  request<DiscoveryReport[]>('/api/v1/tools/discovery');

/** Public names claimed by more than one backend tool. Withheld, not routed. */
export const getToolConflicts = (): Promise<ToolConflict[]> =>
  request<ToolConflict[]>('/api/v1/tools/conflicts');
