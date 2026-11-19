import type { Backend, BackendRuntimeStatus } from '@/lib/api/types';

/**
 * Which controls are meaningful for a backend right now.
 *
 * Derived from the gateway's own rules rather than invented here:
 *
 *  * `connect` returns early when the status is already `connected` or
 *    `connecting` (`BackendLifecycleManager.connect`), so offering it then would
 *    be a button that does nothing.
 *  * `connect` and `reconnect` throw `409 RESOURCE_CONFLICT` on a disabled
 *    backend, so they are hidden rather than shown-and-failing.
 *  * `disconnect` is idempotent, but only offers value above `disconnected`.
 *  * `disable` always ends any live connection, so it is the safe action in
 *    every live state.
 *
 * A `disabled` backend's runtime status is the string `disabled`; an enabled one
 * with no adapter history reads `disconnected`. The two are separate facts, so
 * both are consulted.
 */

export type BackendAction = 'connect' | 'disconnect' | 'reconnect' | 'enable' | 'disable' | 'delete';

export interface ActionAvailability {
  connect: boolean;
  disconnect: boolean;
  reconnect: boolean;
  enable: boolean;
  disable: boolean;
  delete: boolean;
}

const LIVE: readonly BackendRuntimeStatus[] = ['connected', 'unhealthy', 'connecting', 'disconnecting'];

export function actionAvailability(backend: Backend): ActionAvailability {
  const status = backend.runtime?.status ?? (backend.enabled ? 'disconnected' : 'disabled');
  const busy = status === 'connecting' || status === 'disconnecting';

  return {
    // Already connected/connecting: connect is a no-op. Busy: wait.
    connect: backend.enabled && !busy && status !== 'connected',
    // Nothing to tear down in rest states.
    disconnect: status !== 'disconnected' && status !== 'disabled',
    // A retry is a fresh attempt; only when the backend may dial at all.
    reconnect: backend.enabled && !busy,
    enable: !backend.enabled,
    disable: backend.enabled,
    delete: true,
  };
}

/**
 * Whether a state should animate its indicator.
 *
 * Transient states are the only ones with motion; `prefers-reduced-motion` is
 * honoured by the CSS, not here, so this stays a pure data question.
 */
export function isTransientStatus(status: BackendRuntimeStatus): boolean {
  return status === 'connecting' || status === 'disconnecting';
}

/** States in which an operator should look at the error, not the configuration. */
export function isFailureStatus(status: BackendRuntimeStatus): boolean {
  return status === 'error' || status === 'unhealthy';
}

/**
 * Runtime status for display, preferring the per-backend runtime read.
 *
 * The list response carries a reduced runtime (`status` + `updatedAt`); the
 * detail page additionally reads `/runtime`, which is the only source of
 * `lastError*`, `lastConnectedAt` and `reconnectAttempts`. Falling back to the
 * configuration-visible status keeps the page honest when that read has not
 * happened, instead of rendering a blank status.
 */
export function effectiveStatus(
  backend: Backend,
  runtime?: { status: BackendRuntimeStatus } | undefined,
): BackendRuntimeStatus {
  if (runtime !== undefined) return runtime.status;
  if (backend.runtime !== undefined) return backend.runtime.status;
  return backend.enabled ? 'disconnected' : 'disabled';
}

/** Statuses the list's own vocabulary allows filtering by — for tests and docs. */
export const LIVE_STATUSES: readonly BackendRuntimeStatus[] = LIVE;
