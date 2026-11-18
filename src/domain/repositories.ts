import type { Agent, CreateAgentInput, UpdateAgentInput } from '../domain/agent.js';
import type { AgentCredential, CreateCredentialInput } from '../domain/agent-credential.js';
import type { ActivityEvent } from '../domain/activity-event.js';
import type { AuditEvent } from '../domain/audit-event.js';
import type { Backend, CreateBackendInput, UpdateBackendInput } from '../domain/backend.js';
import type { TransportType } from '../domain/backend.js';
import type { BackendRuntime } from '../domain/backend-runtime.js';
import type { CreatePolicyInput, Policy, UpdatePolicyInput } from '../domain/policy.js';
import type { Session, SessionStatus, SessionTerminationReason } from '../domain/session.js';

/**
 * Persistence contracts.
 *
 * Implemented by SQLite repositories, but declared in domain terms: no SQL,
 * no better-sqlite3 types, no transaction handles. Any future store (or an
 * in-memory fake in a test) satisfies the same interface.
 */

/** Listing/filtering criteria for the management API. Pagination is required. */
export interface BackendQuery {
  /** Case-insensitive substring match on name or description. */
  search?: string;
  transport?: TransportType;
  enabled?: boolean;
  limit: number;
  offset: number;
  sort: 'name' | 'createdAt' | 'updatedAt';
  order: 'asc' | 'desc';
}

export interface BackendPage {
  items: Backend[];
  /** Total matching records, independent of pagination. */
  total: number;
}

export interface BackendRepository {
  create(input: CreateBackendInput, now: string): Backend;
  findById(id: string): Backend | undefined;
  findByName(name: string): Backend | undefined;
  list(): Backend[];
  query(criteria: BackendQuery): BackendPage;
  /**
   * Partial update. When `expectedVersion` is supplied the write is a
   * compare-and-set: a stale version throws `RESOURCE_CONFLICT` instead of
   * silently overwriting a concurrent edit.
   */
  update(id: string, input: UpdateBackendInput, now: string, expectedVersion?: number): Backend;
  /** Tombstones the backend: it disappears from lists, history keeps the reference. */
  softDelete(id: string, now: string): void;
  countActive(): number;
}

export interface BackendRuntimeRepository {
  /** Creates or replaces the runtime row for a backend. */
  upsert(runtime: BackendRuntime): BackendRuntime;
  findByBackendId(backendId: string): BackendRuntime | undefined;
  /** Every runtime row. Bounded by the registry size; used for startup recovery. */
  list(): BackendRuntime[];
}

export interface AgentQuery {
  /** Case-insensitive substring match on name or description. */
  search?: string;
  enabled?: boolean;
  clientType?: string;
  limit: number;
  offset: number;
  sort: 'name' | 'createdAt' | 'updatedAt';
  order: 'asc' | 'desc';
}

export interface AgentPage {
  items: Agent[];
  total: number;
}

export interface AgentRepository {
  create(input: CreateAgentInput, now: string): Agent;
  findById(id: string): Agent | undefined;
  findByName(name: string): Agent | undefined;
  list(): Agent[];
  query(criteria: AgentQuery): AgentPage;
  update(id: string, input: UpdateAgentInput, now: string): Agent;
  /** Records a successful credential authentication. Separate from `update`: no audit row. */
  touchAuthentication(id: string, now: string): void;
  softDelete(id: string, now: string): void;
  countActive(): number;
}

export interface CredentialRepository {
  create(input: CreateCredentialInput, now: string): AgentCredential;
  findById(id: string): AgentCredential | undefined;
  findByHash(credentialHash: string): AgentCredential | undefined;
  listByAgentId(agentId: string): AgentCredential[];
  /** Revocation is a timestamp, never a delete: the audit trail keeps the row. */
  revoke(id: string, now: string): AgentCredential;
  /** Revokes every unrevoked credential of one agent; returns how many changed. */
  revokeAllForAgent(agentId: string, now: string): number;
  touch(id: string, now: string): void;
}

export interface PolicyQuery {
  search?: string;
  effect?: 'allow' | 'deny';
  /** Only policies assigned to this agent. */
  agentId?: string;
  limit: number;
  offset: number;
  sort: 'name' | 'createdAt' | 'updatedAt' | 'priority';
  order: 'asc' | 'desc';
}

export interface PolicyPage {
  items: Policy[];
  total: number;
}

export interface PolicyRepository {
  create(input: CreatePolicyInput, now: string): Policy;
  findById(id: string): Policy | undefined;
  findByName(name: string): Policy | undefined;
  list(): Policy[];
  query(criteria: PolicyQuery): PolicyPage;
  update(id: string, input: UpdatePolicyInput, now: string): Policy;
  delete(id: string): void;
  assign(agentId: string, policyId: string, now: string): void;
  unassign(agentId: string, policyId: string): void;
  listPoliciesForAgent(agentId: string): Policy[];
  /** Removes every assignment of one agent. Used when an agent is deleted. */
  unassignAll(agentId: string): number;
}

/** Operational history: append + bounded read. No update, no delete. */
export interface ActivityRepository {
  append(event: ActivityEvent): ActivityEvent;
  list(limit: number): ActivityEvent[];
  count(): number;
}

/**
 * Administrative history: append + bounded read. Deliberately has no update or
 * delete method — audit rows are immutable from the application's perspective.
 */
export interface AuditRepository {
  append(event: AuditEvent): AuditEvent;
  list(limit: number): AuditEvent[];
  count(): number;
}

export interface SessionQuery {
  agentId?: string;
  status?: SessionStatus;
  /** Only sessions created at or after this instant. */
  createdAfter?: string;
  /** Only sessions created at or before this instant. */
  createdBefore?: string;
  /** Only sessions active at or after this instant (last activity). */
  lastActivityAfter?: string;
  limit: number;
  offset: number;
  sort: 'createdAt' | 'lastActivityAt';
  order: 'asc' | 'desc';
  /** Clock for effective-status filtering. Defaults to the current instant. */
  now?: string;
  /** `now` minus the configured idle timeout, for the same reason. */
  idleCutoff?: string;
}

export interface SessionPage {
  items: Session[];
  total: number;
}

/**
 * Persistent sessions.
 *
 * Every mutating method is a single conditional statement whose predicate
 * carries the state check ("still active", "still unbound"), so the decision
 * and the write cannot be interleaved by another writer. Callers never read a
 * row and then write it back unguarded.
 */
export interface SessionRepository {
  create(session: Session): Session;
  findById(id: string): Session | undefined;
  findByMcpSessionId(mcpSessionId: string): Session | undefined;
  listByAgentId(agentId: string): Session[];
  query(criteria: SessionQuery): SessionPage;
  /** Extends the idle clock. No-op for a session that is no longer active. */
  touch(id: string, now: string): void;
  /** Ends an active session. Idempotent: a finished session is returned unchanged. */
  end(id: string, now: string, status: 'expired' | 'terminated' | 'invalidated', reason: SessionTerminationReason): Session;
  /** Ends every active session matching the filter. Returns the rows that changed. */
  endWhere(
    filter: { agentId?: string; credentialId?: string; ids?: string[] },
    now: string,
    status: 'expired' | 'terminated' | 'invalidated',
    reason: SessionTerminationReason,
  ): Session[];
  /**
   * Marks idle-expired and over-lifetime sessions. Auditable history is kept:
   * the row is retained with a status and a reason, never deleted.
   * Returns the rows that changed.
   */
  expire(now: string, idleCutoff: string): Session[];
  count(): number;
  countByStatus(status: SessionStatus): number;
}

/** Every repository a store provides, wired once at startup. */
export interface Repositories {
  backends: BackendRepository;
  backendRuntime: BackendRuntimeRepository;
  agents: AgentRepository;
  credentials: CredentialRepository;
  policies: PolicyRepository;
  sessions: SessionRepository;
  activity: ActivityRepository;
  audit: AuditRepository;
}
