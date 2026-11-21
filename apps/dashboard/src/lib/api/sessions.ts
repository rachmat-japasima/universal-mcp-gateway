import { request, requestPage } from './client';
import type { Page, Session, SessionQuery, SessionTerminationReason } from './types';

/**
 * MCP session management (Phase 10.5).
 *
 * One function per documented route in `src/api/routes/sessions.routes.ts`.
 * Facts that shape these signatures:
 *
 *  * **These are agent sessions, not operator sessions.** `operator_sessions` is
 *    a different table with a different lifetime, and no function here can read
 *    it. Mixing the two on one screen would blur the only boundary that makes
 *    either identity meaningful.
 *  * **`status` filters on the effective status.** An idle-expired session whose
 *    sweep has not run yet still answers `expired`, so the filter and the row
 *    agree without the dashboard deriving a status of its own.
 *  * **There is no `search`.** The list answers filters the gateway defines and
 *    nothing else; an id lookup goes to `getSession`, which is the real detail
 *    read (and a `400` — not a `404` — for a non-UUID, so ids cannot be probed).
 *  * **Termination is a server operation.** It ends the row, releases the
 *    transport, writes one audit record, and every later request with that
 *    protocol id is refused. Nothing here is a frontend status update.
 */

export const listSessions = (query: SessionQuery = {}): Promise<Page<Session>> =>
  requestPage<Session>('/api/v1/sessions', { ...query });

export const getSession = (sessionId: string): Promise<Session> =>
  request<Session>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);

/**
 * Terminates a session. Idempotent: a repeat returns the already-finished row
 * and never reactivates it, so a double click cannot produce two terminations.
 *
 * The reason defaults to `operator_terminated` on the gateway, which is exactly
 * what this action is, so no body is sent.
 */
export const terminateSession = (
  sessionId: string,
  reason?: SessionTerminationReason,
): Promise<Session> =>
  request<Session>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/terminate`,
    {},
    { method: 'POST', ...(reason === undefined ? {} : { body: { reason } }) },
  );
