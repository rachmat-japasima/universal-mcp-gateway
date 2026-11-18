import { Hono } from 'hono';
import { z } from 'zod';

import { createAgentSchema, updateAgentSchema } from '../../domain/agent.js';
import type { AuthorizationService } from '../../auth/authorization.js';
import type { CredentialService } from '../../registry/credential-service.js';
import { toPublicCredential } from '../../registry/credential-service.js';
import { toPublicAgent, type AgentService } from '../../registry/agent-service.js';
import { AppError, formatZodIssues } from '../../shared/errors.js';
import { getRequestId, ok, parseQuery, readJson } from '../http.js';
import {
  agentIdParamSchema,
  credentialIdParamSchema,
  issueCredentialBodySchema,
  listAgentsQuerySchema,
  pageMetadata,
} from '../schemas/queries.js';

/**
 * Agent and credential management routes.
 *
 * Each handler parses, calls a service, and formats. No SQL, no authorization
 * logic, and no audit writes here — the same division the backend routes keep.
 *
 * The credential routes exist under an agent id on purpose: a credential is not
 * addressable without its owner, so an id from another agent cannot be used.
 */

function parseParam<T>(schema: z.ZodType<T>, value: unknown, requestId: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new AppError('VALIDATION_ERROR', formatZodIssues(parsed.error) ?? 'The route parameter is invalid.', {
    requestId,
  });
}

export interface AgentRouteDependencies {
  agents: AgentService;
  credentials: CredentialService;
  authorization: AuthorizationService;
}

/** The two ids a credential sub-resource needs. */
const credentialParams = z.object({
  agentId: agentIdParamSchema.shape.agentId,
  credentialId: credentialIdParamSchema.shape.credentialId,
});

export function agentsRoutes(deps: AgentRouteDependencies): Hono {
  const { agents, credentials, authorization } = deps;
  const routes = new Hono();

  routes.get('/', (c) => {
    const query = parseQuery(c, listAgentsQuerySchema);
    const { items, total } = agents.list(query);

    return ok(c, items.map(toPublicAgent), {
      pagination: pageMetadata(query.page, query.limit, total),
    });
  });

  routes.post('/', async (c) => {
    const body = await readJson(c, createAgentSchema);
    return ok(c, toPublicAgent(agents.create(body)), {}, 201);
  });

  /**
   * Read-only effective access. Declared before `/:agentId` for the same reason
   * `/backends/runtime` is: a literal must never be parsed as an id.
   */
  routes.get('/:agentId/access', (c) => {
    const { agentId } = parseParam(agentIdParamSchema, c.req.param(), getRequestId(c));
    const agent = agents.get(agentId);
    return ok(c, authorization.describeAccess(agent));
  });

  routes.get('/:agentId', (c) => {
    const { agentId } = parseParam(agentIdParamSchema, c.req.param(), getRequestId(c));
    return ok(c, toPublicAgent(agents.get(agentId)));
  });

  routes.patch('/:agentId', async (c) => {
    const { agentId } = parseParam(agentIdParamSchema, c.req.param(), getRequestId(c));
    const body = await readJson(c, updateAgentSchema);
    return ok(c, toPublicAgent(agents.update(agentId, body)));
  });

  /**
   * Deletes the agent, revoking every credential and removing every policy
   * assignment in the same transaction. The response reports what was withdrawn
   * so an operator can confirm the blast radius.
   */
  routes.delete('/:agentId', (c) => {
    const { agentId } = parseParam(agentIdParamSchema, c.req.param(), getRequestId(c));
    const removed = agents.remove(agentId);

    return ok(c, {
      ...toPublicAgent(removed.agent),
      revokedCredentials: removed.revokedCredentials,
      removedAssignments: removed.removedAssignments,
    });
  });

  for (const enabled of [true, false] as const) {
    routes.post(enabled ? '/:agentId/enable' : '/:agentId/disable', (c) => {
      const { agentId } = parseParam(agentIdParamSchema, c.req.param(), getRequestId(c));
      return ok(c, toPublicAgent(agents.setEnabled(agentId, enabled)));
    });
  }

  // --- credentials -------------------------------------------------------

  routes.get('/:agentId/credentials', (c) => {
    const { agentId } = parseParam(agentIdParamSchema, c.req.param(), getRequestId(c));

    // Not paginated: an agent's credential count is a handful by construction,
    // and the list is already bounded by the agent's own lifecycle.
    return ok(c, credentials.list(agentId).map((credential) => toPublicCredential(credential)));
  });

  routes.post('/:agentId/credentials', async (c) => {
    const { agentId } = parseParam(agentIdParamSchema, c.req.param(), getRequestId(c));
    const body = await readJson(c, issueCredentialBodySchema);
    const { credential, token } = credentials.issue(agentId, body);

    // `201` with the raw token: this is the only response in the product that
    // contains one. It cannot be retrieved again.
    return ok(
      c,
      { ...toPublicCredential(credential), token },
      { notice: 'The token is shown once and cannot be retrieved again.' },
      201,
    );
  });

  routes.post('/:agentId/credentials/:credentialId/rotate', async (c) => {
    const { agentId, credentialId } = parseParam(credentialParams, c.req.param(), getRequestId(c));
    const body = await readJson(c, issueCredentialBodySchema);
    const { credential, token } = credentials.rotate(agentId, credentialId, body);

    return ok(
      c,
      { ...toPublicCredential(credential), token },
      {
        notice: 'The previous credential was revoked. The new token is shown once.',
        previousCredentialId: credentialId,
      },
    );
  });

  /** Credential id is validated so a malformed segment is a validation error, not a lookup miss. */
  routes.post('/:agentId/credentials/:credentialId/revoke', (c) => {
    const { agentId, credentialId } = parseParam(credentialParams, c.req.param(), getRequestId(c));
    return ok(c, toPublicCredential(credentials.revoke(agentId, credentialId)));
  });

  return routes;
}
