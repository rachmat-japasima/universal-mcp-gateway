import { z } from 'zod';

/** Query contracts for the management API. Bounds are enforced here, not in handlers. */

export const MAX_PAGE_SIZE = 100;

const booleanFlag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

/** 1-based page; `limit` is capped so one request cannot scan the table. */
export const listBackendsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
    /** Substring match on name or description. */
    search: z.string().trim().min(1).max(200).optional(),
    transport: z.enum(['stdio', 'streamable-http']).optional(),
    enabled: booleanFlag.optional(),
    sort: z.enum(['name', 'createdAt', 'updatedAt']).default('name'),
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  // `.strict()` on a query string would reject unknown keys, which browsers and
  // proxies add freely (`utm_*`, cache busters). Unknown keys are ignored here.
  .transform(({ page, limit, ...rest }) => ({ ...rest, limit, offset: (page - 1) * limit, page }));

/** Route parameters are untrusted input like any other. */
export const backendIdParamSchema = z.object({
  backendId: z.uuid(),
});

export const agentIdParamSchema = z.object({
  agentId: z.uuid(),
});

export const credentialIdParamSchema = z.object({
  credentialId: z.uuid(),
});

export const policyIdParamSchema = z.object({
  policyId: z.uuid(),
});

export const sessionIdParamSchema = z.object({
  sessionId: z.uuid(),
});

/**
 * Session listing.
 *
 * `status` filters on the *effective* status, so `expired` finds sessions whose
 * lifetime lapsed but which the cleanup sweep has not written back yet. Time
 * filters are absolute UTC instants, matching every other timestamp in the API.
 */
export const listSessionsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
    agentId: z.uuid().optional(),
    status: z.enum(['active', 'expired', 'terminated', 'invalidated']).optional(),
    createdAfter: z.iso.datetime().optional(),
    createdBefore: z.iso.datetime().optional(),
    lastActivityAfter: z.iso.datetime().optional(),
    sort: z.enum(['createdAt', 'lastActivityAt']).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .transform(({ page, limit, ...rest }) => ({ ...rest, limit, offset: (page - 1) * limit, page }));

export const listAgentsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
    /** Substring match on name or description. */
    search: z.string().trim().min(1).max(200).optional(),
    enabled: booleanFlag.optional(),
    status: z.enum(['active', 'disabled']).optional(),
    clientType: z.string().trim().min(1).max(64).optional(),
    sort: z.enum(['name', 'createdAt', 'updatedAt']).default('name'),
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  .transform(({ page, limit, status, ...rest }) => ({
    ...rest,
    // `status` is derived from `enabled`; the two cannot contradict each other.
    ...(status === undefined ? {} : { enabled: status === 'active' }),
    limit,
    offset: (page - 1) * limit,
    page,
  }));

export const listPoliciesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
    search: z.string().trim().min(1).max(200).optional(),
    /** Policies containing at least one rule with this effect. */
    effect: z.enum(['allow', 'deny']).optional(),
    agentId: z.uuid().optional(),
    backendId: z.uuid().optional(),
    sort: z.enum(['name', 'createdAt', 'updatedAt', 'priority']).default('name'),
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  .transform(({ page, limit, backendId, ...rest }) => ({
    ...rest,
    ...(backendId === undefined ? {} : { backendId }),
    limit,
    offset: (page - 1) * limit,
    page,
  }));

/** Credential issue/rotate body. `expiresAt` is an absolute instant, validated by the domain schema. */
export const issueCredentialBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();

/**
 * `?expectedVersion=` on update/enable/disable. Optional: a caller that omits it
 * opts into last-write-wins, which is the documented behaviour for scripts.
 */
export const expectedVersionSchema = z.coerce.number().int().min(1).optional();

export const pageMetadata = (page: number, limit: number, total: number): {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
} => ({ page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) });
