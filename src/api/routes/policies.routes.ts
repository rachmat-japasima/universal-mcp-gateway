import { Hono } from 'hono';
import { z } from 'zod';

import { createPolicySchema, updatePolicySchema } from '../../domain/policy.js';
import { toPublicPolicy, type PolicyService } from '../../registry/policy-service.js';
import { AppError, formatZodIssues } from '../../shared/errors.js';
import { getRequestId, ok, parseQuery, readJson } from '../http.js';
import { agentIdParamSchema, listPoliciesQuerySchema, pageMetadata, policyIdParamSchema } from '../schemas/queries.js';

/**
 * Policy management routes.
 *
 * Assignment is expressed as a sub-resource of the policy
 * (`POST /policies/:policyId/assignments`) rather than a field on the policy or
 * on the agent: a policy is shared, so "who has this" is a relation, and both
 * sides name each other by id.
 */

function parseParam<T>(schema: z.ZodType<T>, value: unknown, requestId: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new AppError('VALIDATION_ERROR', formatZodIssues(parsed.error) ?? 'The route parameter is invalid.', {
    requestId,
  });
}

const assignmentBodySchema = z.object({ agentId: z.uuid() }).strict();

export function policiesRoutes(service: PolicyService): Hono {
  const routes = new Hono();

  routes.get('/', (c) => {
    const query = parseQuery(c, listPoliciesQuerySchema);

    /**
     * Every filter, including `backendId`, is applied by the repository so
     * `pagination.total` describes the filtered set. A filter applied after
     * slicing would report a page of the wrong size with the wrong total.
     */
    const page = service.list(query);

    return ok(c, page.items.map(toPublicPolicy), {
      pagination: pageMetadata(query.page, query.limit, page.total),
    });
  });

  routes.post('/', async (c) => {
    const body = await readJson(c, createPolicySchema);
    return ok(c, toPublicPolicy(service.create(body)), {}, 201);
  });

  routes.get('/:policyId', (c) => {
    const { policyId } = parseParam(policyIdParamSchema, c.req.param(), getRequestId(c));
    return ok(c, toPublicPolicy(service.get(policyId)));
  });

  routes.patch('/:policyId', async (c) => {
    const { policyId } = parseParam(policyIdParamSchema, c.req.param(), getRequestId(c));
    const body = await readJson(c, updatePolicySchema);
    return ok(c, toPublicPolicy(service.update(policyId, body)));
  });

  routes.delete('/:policyId', (c) => {
    const { policyId } = parseParam(policyIdParamSchema, c.req.param(), getRequestId(c));
    return ok(c, toPublicPolicy(service.remove(policyId)));
  });

  routes.post('/:policyId/assignments', async (c) => {
    const { policyId } = parseParam(policyIdParamSchema, c.req.param(), getRequestId(c));
    const { agentId } = await readJson(c, assignmentBodySchema);

    return ok(c, toPublicPolicy(service.assign(agentId, policyId)));
  });

  routes.delete('/:policyId/assignments/:agentId', (c) => {
    const { policyId, agentId } = parseParam(
      z.object({ policyId: z.uuid(), agentId: agentIdParamSchema.shape.agentId }),
      c.req.param(),
      getRequestId(c),
    );

    return ok(c, toPublicPolicy(service.unassign(agentId, policyId)));
  });

  return routes;
}
