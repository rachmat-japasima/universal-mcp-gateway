import { request, requestPage } from './client';
import type {
  Backend,
  BackendConnection,
  BackendQuery,
  BackendRuntimeView,
  BackendTransport,
  BackendValidationResult,
  ConcurrencyMode,
  Page,
} from './types';

/**
 * Backend management endpoints (Phase 10.1).
 *
 * One function per documented route — the list is `docs/API_REFERENCE.md` §
 * "Backends" and `src/api/routes/backends.routes.ts`. Nothing here invents a
 * field, a filter, or an operation.
 *
 * Two contract facts that shape every signature below:
 *
 *  * **`expectedVersion` is a query parameter, not a body field.** It makes
 *    `PATCH`, `enable` and `disable` a compare-and-set; omitting it is a blind
 *    write. The dashboard always sends the version it rendered, so a stale tab
 *    gets a `409` instead of silently overwriting someone else's edit.
 *  * **Secrets are references.** `env` and `headers` values are `secret:<path>`
 *    or `env:<VAR>` strings validated by `secretRefSchema`; a literal value is
 *    rejected by the gateway. No response can carry a secret because none is
 *    ever stored — the dashboard has nothing to redact, only to refuse.
 */

/** What the create form submits. Mirrors `createBackendSchema`. */
export interface BackendCreateInput {
  name: string;
  description?: string;
  connection: BackendConnection;
  enabled?: boolean;
  timeoutMs?: number;
  concurrencyMode?: ConcurrencyMode;
  concurrencyLimit?: number;
}

/**
 * `updateBackendSchema` deliberately has no defaults: `undefined` keeps a field,
 * `null` clears a nullable one. So this is a partial of the create input plus
 * `null` where the gateway accepts it.
 */
export interface BackendUpdateInput {
  name?: string;
  description?: string | null;
  connection?: BackendConnection;
  enabled?: boolean;
  timeoutMs?: number;
  concurrencyMode?: ConcurrencyMode;
  concurrencyLimit?: number | null;
}

export const listBackends = (query: BackendQuery = {}): Promise<Page<Backend>> =>
  requestPage<Backend>('/api/v1/backends', { ...query });

export const getBackend = (backendId: string): Promise<Backend> =>
  request<Backend>(`/api/v1/backends/${encodeURIComponent(backendId)}`);

export const getBackendRuntime = (backendId: string): Promise<BackendRuntimeView> =>
  request<BackendRuntimeView>(`/api/v1/backends/${encodeURIComponent(backendId)}/runtime`);

export const getAllBackendRuntime = (): Promise<BackendRuntimeView[]> =>
  request<BackendRuntimeView[]>('/api/v1/backends/runtime');

/**
 * Validates a proposed configuration without persisting it or dialling anything.
 *
 * The gateway answers `200` with per-field issues even for a nonsense body, so a
 * rejected config is not an `ApiError` — it is a result to render. Only a
 * transport failure or an unparseable answer throws.
 */
export const validateBackend = (input: unknown): Promise<BackendValidationResult> =>
  request<BackendValidationResult>('/api/v1/backends/validate', {}, {
    method: 'POST',
    body: input,
  });

export const createBackend = (input: BackendCreateInput): Promise<Backend> =>
  request<Backend>('/api/v1/backends', {}, { method: 'POST', body: input });

export const updateBackend = (backendId: string, input: BackendUpdateInput, expectedVersion: number): Promise<Backend> =>
  request<Backend>(`/api/v1/backends/${encodeURIComponent(backendId)}`, { expectedVersion }, {
    method: 'PATCH',
    body: input,
  });

export const deleteBackend = (backendId: string): Promise<Backend> =>
  request<Backend>(`/api/v1/backends/${encodeURIComponent(backendId)}`, {}, { method: 'DELETE' });

/** Enable/disable are compare-and-set: the version proves the caller saw current state. */
export const setBackendEnabled = (backendId: string, enabled: boolean, expectedVersion: number): Promise<Backend> =>
  request<Backend>(
    `/api/v1/backends/${encodeURIComponent(backendId)}/${enabled ? 'enable' : 'disable'}`,
    { expectedVersion },
    { method: 'POST' },
  );

/**
 * Connection control. Each returns the resulting runtime state, not the backend.
 *
 * `connect`/`reconnect` answer `409 RESOURCE_CONFLICT` on a disabled backend —
 * a caller must not treat that as "it did nothing and probably worked".
 */
export const connectBackend = (backendId: string): Promise<BackendRuntimeView> =>
  request<BackendRuntimeView>(`/api/v1/backends/${encodeURIComponent(backendId)}/connect`, {}, { method: 'POST' });

export const disconnectBackend = (backendId: string): Promise<BackendRuntimeView> =>
  request<BackendRuntimeView>(`/api/v1/backends/${encodeURIComponent(backendId)}/disconnect`, {}, { method: 'POST' });

export const reconnectBackend = (backendId: string): Promise<BackendRuntimeView> =>
  request<BackendRuntimeView>(`/api/v1/backends/${encodeURIComponent(backendId)}/reconnect`, {}, { method: 'POST' });

/** The `transport` filter's own vocabulary, so a form cannot offer an unsupported value. */
export const BACKEND_TRANSPORTS: readonly BackendTransport[] = ['stdio', 'streamable-http'];
