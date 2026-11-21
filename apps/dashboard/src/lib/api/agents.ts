import { request, requestPage } from './client';
import type {
  Agent,
  AgentAccess,
  AgentCreateInput,
  AgentCredential,
  AgentQuery,
  AgentUpdateInput,
  IssuedCredential,
  Page,
} from './types';

/**
 * Agent and credential management (Phase 10.3).
 *
 * One function per documented route (`docs/API_REFERENCE.md` §3.5 and
 * `src/api/routes/agents.routes.ts`). Facts that shape the signatures:
 *
 *  * **No version field exists on an agent.** Writes are plain `PATCH`/`POST`; a
 *    concurrent edit is last-writer-wins at the API. The UI therefore re-reads
 *    after every write rather than promising a compare-and-set it cannot make.
 *  * **A credential is addressed under its agent.** There is no global credential
 *    id route, so every call carries `agentId` and an id from another agent is a
 *    `404`.
 *  * **The token is returned exactly once.** `issueCredential` and
 *    `rotateCredential` are the only two functions whose result contains one, and
 *    no other call can retrieve it.
 *  * **Rotation is replace-semantics.** The previous credential is revoked in the
 *    same transaction — there is no grace period — and sessions bound to it are
 *    invalidated.
 */

export const listAgents = (query: AgentQuery = {}): Promise<Page<Agent>> =>
  requestPage<Agent>('/api/v1/agents', { ...query });

export const getAgent = (agentId: string): Promise<Agent> =>
  request<Agent>(`/api/v1/agents/${encodeURIComponent(agentId)}`);

export const createAgent = (input: AgentCreateInput): Promise<Agent> =>
  request<Agent>('/api/v1/agents', {}, { method: 'POST', body: input });

export const updateAgent = (agentId: string, input: AgentUpdateInput): Promise<Agent> =>
  request<Agent>(`/api/v1/agents/${encodeURIComponent(agentId)}`, {}, { method: 'PATCH', body: input });

/** Deletes (tombstones) the agent, revoking credentials and dropping assignments. */
export const deleteAgent = (
  agentId: string,
): Promise<Agent & { revokedCredentials: number; removedAssignments: number }> =>
  request<Agent & { revokedCredentials: number; removedAssignments: number }>(
    `/api/v1/agents/${encodeURIComponent(agentId)}`,
    {},
    { method: 'DELETE' },
  );

/** Disabling refuses new sessions and invalidates the agent's live ones. */
export const setAgentEnabled = (agentId: string, enabled: boolean): Promise<Agent> =>
  request<Agent>(
    `/api/v1/agents/${encodeURIComponent(agentId)}/${enabled ? 'enable' : 'disable'}`,
    {},
    { method: 'POST' },
  );

/**
 * Effective access, as the gateway's own evaluator computes it.
 *
 * Not paginated and not filtered: it lists every *available* catalog tool with
 * the decision `AuthorizationService.evaluate` reached for this agent. The
 * dashboard must render this rather than re-implementing the rules in a browser —
 * a second evaluator would be a second answer.
 */
export const getAgentAccess = (agentId: string): Promise<AgentAccess> =>
  request<AgentAccess>(`/api/v1/agents/${encodeURIComponent(agentId)}/access`);

/** Credential metadata only. Never a token. */
export const listCredentials = (agentId: string): Promise<AgentCredential[]> =>
  request<AgentCredential[]>(`/api/v1/agents/${encodeURIComponent(agentId)}/credentials`);

/** `201` with the raw token. The only way to obtain one. */
export const issueCredential = (
  agentId: string,
  input: { name?: string; expiresAt?: string } = {},
): Promise<IssuedCredential> =>
  request<IssuedCredential>(`/api/v1/agents/${encodeURIComponent(agentId)}/credentials`, {}, {
    method: 'POST',
    body: input,
  });

/** Replaces the credential and returns the new token. The old one stops working immediately. */
export const rotateCredential = (
  agentId: string,
  credentialId: string,
  input: { name?: string; expiresAt?: string } = {},
): Promise<IssuedCredential> =>
  request<IssuedCredential>(
    `/api/v1/agents/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(credentialId)}/rotate`,
    {},
    { method: 'POST', body: input },
  );

/** Idempotent: revoking an already-revoked credential returns it unchanged. */
export const revokeCredential = (agentId: string, credentialId: string): Promise<AgentCredential> =>
  request<AgentCredential>(
    `/api/v1/agents/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(credentialId)}/revoke`,
    {},
    { method: 'POST' },
  );
