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
