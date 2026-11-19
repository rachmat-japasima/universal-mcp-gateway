/**
 * What the dashboard's write proxy will forward.
 *
 * Kept apart from the route handler so the perimeter is testable without a
 * Next.js request, a gateway, or a session — the three things that would
 * otherwise make "does this proxy accept `/backends/../../agents`?" a manual
 * question.
 *
 * The rules are deliberately narrow:
 *
 *  * Only `POST`, `PATCH` and `DELETE` — the read proxy already covers `GET`.
 *  * Only backend management paths. A passthrough would make this an open door
 *    to the whole management plane for anything that can load a dashboard page.
 *  * Item paths must be a **UUID**, and the expression is anchored with `$`, so
 *    a traversal segment cannot be expressed as a match at all.
 */

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

const ITEM = new RegExp(`^/api/v1/backends/${UUID}$`);
const ACTION = new RegExp(`^/api/v1/backends/${UUID}/(enable|disable|connect|disconnect|reconnect)$`);

const COLLECTION = new Set(['/api/v1/backends', '/api/v1/backends/validate']);

export type WriteMethod = 'POST' | 'PATCH' | 'DELETE';

export function isAllowedWrite(method: string, target: string): boolean {
  if (method === 'PATCH' || method === 'DELETE') {
    // Only the item path accepts these: `POST /backends` is create, and
    // `DELETE /backends` does not exist.
    return ITEM.test(target);
  }

  if (method !== 'POST') return false;

  // `enable`/`disable` take a compare-and-set version; `connect`/`disconnect`/
  // `reconnect` take no body. None of them accepts a PATCH.
  return COLLECTION.has(target) || ITEM.test(target) || ACTION.test(target);
}
