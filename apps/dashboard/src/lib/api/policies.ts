import { request, requestPage } from './client';
import type { Agent, Page, Policy, PolicyCreateInput, PolicyQuery, PolicyUpdateInput } from './types';

/**
 * Policy management (Phase 10.4).
 *
 * One function per documented route in `src/api/routes/policies.routes.ts`.
 * Facts that shape these signatures:
 *
 *  * **A rule is not a resource.** `rules` is a field of the policy, replaced
 *    wholesale by `PATCH`, so there is no "add rule" endpoint to call and no
 *    partial merge to rely on.
 *  * **`DELETE` is a hard delete.** Assignments cascade and every grant the
 *    policy carried disappears with it — the safe direction, but destructive.
 *  * **Assignment is a sub-resource of the policy**, addressed by agent id in the
 *    body (`POST`) or path (`DELETE`). `POST` is idempotent.
 *  * **`GET …/assignments` is the reverse lookup**, the counterpart of
 *    `GET /agents/:id/access`. Without it the detail page could state what a
 *    policy grants but not who receives it.
 */

export const listPolicies = (query: PolicyQuery = {}): Promise<Page<Policy>> =>
  requestPage<Policy>('/api/v1/policies', { ...query });

export const getPolicy = (policyId: string): Promise<Policy> =>
  request<Policy>(`/api/v1/policies/${encodeURIComponent(policyId)}`);

export const createPolicy = (input: PolicyCreateInput): Promise<Policy> =>
  request<Policy>('/api/v1/policies', {}, { method: 'POST', body: input });

export const updatePolicy = (policyId: string, input: PolicyUpdateInput): Promise<Policy> =>
  request<Policy>(`/api/v1/policies/${encodeURIComponent(policyId)}`, {}, { method: 'PATCH', body: input });

/** Hard delete: assignments cascade and every grant it carried is withdrawn. */
export const deletePolicy = (policyId: string): Promise<Policy> =>
  request<Policy>(`/api/v1/policies/${encodeURIComponent(policyId)}`, {}, { method: 'DELETE' });

/** Idempotent: assigning a policy the agent already holds is not an error. */
export const assignPolicy = (policyId: string, agentId: string): Promise<Policy> =>
  request<Policy>(
    `/api/v1/policies/${encodeURIComponent(policyId)}/assignments`,
    {},
    { method: 'POST', body: { agentId } },
  );

/** `404` when the agent is not assigned — the gateway will not pretend it was. */
export const unassignPolicy = (policyId: string, agentId: string): Promise<Policy> =>
  request<Policy>(
    `/api/v1/policies/${encodeURIComponent(policyId)}/assignments/${encodeURIComponent(agentId)}`,
    {},
    { method: 'DELETE' },
  );

/** Which agents hold this policy. Tombstoned agents are excluded by the gateway. */
export const listPolicyAssignments = (policyId: string): Promise<Agent[]> =>
  request<Agent[]>(`/api/v1/policies/${encodeURIComponent(policyId)}/assignments`);
