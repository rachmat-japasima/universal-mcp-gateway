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
 *  * Only the management paths the dashboard actually writes to. A passthrough
 *    would make this an open door to the whole management plane for anything
 *    that can load a dashboard page.
 *  * Item paths must be a **UUID**, and every expression is anchored with `$`,
 *    so a traversal segment cannot be expressed as a match at all.
 */

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

const BACKEND_ITEM = new RegExp(`^/api/v1/backends/${UUID}$`);
const BACKEND_ACTION = new RegExp(`^/api/v1/backends/${UUID}/(enable|disable|connect|disconnect|reconnect)$`);
const BACKEND_TOOLS_REFRESH = new RegExp(`^/api/v1/backends/${UUID}/tools/refresh$`);

const AGENT_ITEM = new RegExp(`^/api/v1/agents/${UUID}$`);
const AGENT_ACTION = new RegExp(`^/api/v1/agents/${UUID}/(enable|disable)$`);
const AGENT_CREDENTIALS = new RegExp(`^/api/v1/agents/${UUID}/credentials$`);
const AGENT_CREDENTIAL_ACTION = new RegExp(
  `^/api/v1/agents/${UUID}/credentials/${UUID}/(rotate|revoke)$`,
);

const POLICY_ITEM = new RegExp(`^/api/v1/policies/${UUID}$`);
const POLICY_ASSIGNMENTS = new RegExp(`^/api/v1/policies/${UUID}/assignments$`);
const POLICY_ASSIGNMENT = new RegExp(`^/api/v1/policies/${UUID}/assignments/${UUID}$`);

/**
 * Managed integrations (ADR-053). `credential` is in the action list because it
 * is the only way a token enters the vault; there is deliberately no rule that
 * could ever forward a `GET` for one. No PATCH exists on this surface at all.
 */
const CONNECTION_ITEM = new RegExp(`^/api/v1/integrations/connections/${UUID}$`);
const CONNECTION_ACTION = new RegExp(
  `^/api/v1/integrations/connections/${UUID}/(credential|test|enable|disable|disconnect)$`,
);

/**
 * Ending an MCP session is the only session write the dashboard makes.
 *
 * `POST /sessions/cleanup` exists on the gateway but is deliberately absent:
 * no screen offers a sweep, and a permission nothing uses is surface area.
 */
const SESSION_TERMINATE = new RegExp(`^/api/v1/sessions/${UUID}/terminate$`);

/**
 * Collections that accept `POST` only.
 *
 * Deliberately absent: `POST /agents/:id/credentials/:id/...` appears above with
 * its exact verb, and nothing matches a bare credential path — the gateway has
 * no such route and this proxy must not be able to ask for one.
 */
const COLLECTION = new Set([
  '/api/v1/backends',
  '/api/v1/backends/validate',
  '/api/v1/tools/refresh',
  '/api/v1/agents',
  '/api/v1/policies',
  '/api/v1/integrations/connections',
]);

export type WriteMethod = 'POST' | 'PATCH' | 'DELETE';

export function isAllowedWrite(method: string, target: string): boolean {
  // The one path that is DELETE-only: unassigning a single agent from a policy.
  if (method === 'DELETE') {
    return (
      BACKEND_ITEM.test(target) ||
      AGENT_ITEM.test(target) ||
      POLICY_ITEM.test(target) ||
      POLICY_ASSIGNMENT.test(target) ||
      CONNECTION_ITEM.test(target)
    );
  }

  if (method === 'PATCH') {
    // Only item paths accept these: `POST /backends` is create, and
    // `DELETE /backends` does not exist. An assignment pair is not an item.
    // Integrations are absent: the surface has no PATCH route, and a rule
    // here would be a permission no screen uses.
    return BACKEND_ITEM.test(target) || AGENT_ITEM.test(target) || POLICY_ITEM.test(target);
  }

  if (method !== 'POST') return false;

  // `enable`/`disable` take a compare-and-set version for backends and none for
  // agents; `connect`/`disconnect`/`reconnect` take no body. None accepts PATCH.
  return (
    COLLECTION.has(target) ||
    BACKEND_ITEM.test(target) ||
    BACKEND_ACTION.test(target) ||
    BACKEND_TOOLS_REFRESH.test(target) ||
    AGENT_ACTION.test(target) ||
    AGENT_CREDENTIALS.test(target) ||
    AGENT_CREDENTIAL_ACTION.test(target) ||
    POLICY_ASSIGNMENTS.test(target) ||
    SESSION_TERMINATE.test(target) ||
    CONNECTION_ACTION.test(target)
  );
}
