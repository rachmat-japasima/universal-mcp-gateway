import type { Agent, CreateAgentInput, UpdateAgentInput } from '../domain/agent.js';
import type { AgentCredential, CreateCredentialInput } from '../domain/agent-credential.js';
import type { ActivityEvent } from '../domain/activity-event.js';
import type { AuditEvent } from '../domain/audit-event.js';
import type { Backend, CreateBackendInput, UpdateBackendInput } from '../domain/backend.js';
import type { TransportType } from '../domain/backend.js';
import type { BackendRuntime } from '../domain/backend-runtime.js';
import type { ConnectionStatus, IntegrationConnection, StoredIntegrationCredential } from '../integrations/connection.js';
import type { CreatePolicyInput, Policy, UpdatePolicyInput } from '../domain/policy.js';
import type { Operator, OperatorSession, OperatorSessionRevocationReason } from '../domain/operator.js';
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
  /** Enabled/disabled split, excluding tombstones. */
  counts(): { total: number; enabled: number; disabled: number };
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
  /** Enabled/disabled split, excluding tombstones. */
  counts(): { total: number; enabled: number; disabled: number };
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
  /** Only policies with a rule targeting this backend id (or `*`). */
  backendId?: string;
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
  /**
   * The reverse of `listPoliciesForAgent`: which agents hold one policy.
   * Excludes tombstoned agents — an assignment to a deleted agent is not a
   * grant anyone can use.
   */
  listAgentsForPolicy(policyId: string): Agent[];
  /** Removes every assignment of one agent. Used when an agent is deleted. */
  unassignAll(agentId: string): number;
}

/** Filters shared by both event logs. Bounds and allowlists live in the API layer. */
export interface EventQuery {
  type?: string;
  agentId?: string;
  backendId?: string;
  /** Exact public tool name. */
  toolName?: string;
  outcome?: string;
  /** Inclusive lower bound on `created_at`, absolute UTC instant. */
  after?: string;
  /** Inclusive upper bound on `created_at`. */
  before?: string;
  /** Substring match on the ids and names the row can carry. */
  search?: string;
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
}

export interface EventPage<T> {
  items: T[];
  total: number;
}

/** Operational history: append + bounded read. No update, no delete. */
export interface ActivityRepository {
  append(event: ActivityEvent): ActivityEvent;
  list(limit: number): ActivityEvent[];
  findById(id: string): ActivityEvent | undefined;
  query(criteria: EventQuery): EventPage<ActivityEvent>;
  count(): number;
  /** Grouped counts over the whole table: one statement, no per-type query. */
  countByType(): Record<string, number>;
  countByOutcome(): Record<string, number>;
}

/** Administrative history, as exposed by the management API's list. */
export interface AuditListItem {
  id: string;
  actorType: AuditEvent['actorType'];
  actorId?: string;
  action: AuditEvent['action'];
  targetType?: AuditEvent['targetType'];
  targetId?: string;
  result: AuditEvent['result'];
  requestId?: string;
  createdAt: string;
}

export interface AuditQuery extends EventQuery {
  /** Audit calls it `action`; the shared filter name stays `type`. */
  actorType?: string;
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  result?: string;
}

/**
 * Administrative history: append + bounded read. Deliberately has no update or
 * delete method — audit rows are immutable from the application's perspective.
 */
export interface AuditRepository {
  append(event: AuditEvent): AuditEvent;
  list(limit: number): AuditEvent[];
  /** Full record, metadata included: the detail endpoint is the disclosure boundary. */
  findById(id: string): AuditEvent | undefined;
  query(criteria: AuditQuery): EventPage<AuditListItem>;
  count(): number;
  countByResult(): Record<string, number>;
  countByActorType(): Record<string, number>;
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
  /**
   * Effective counts per status, in one statement. `active`/`expired` are
   * derived from the same two lifetime rules `query()` filters on, so a
   * dashboard never sees a total that disagrees with the list next to it.
   */
  counts(now: string, idleCutoff: string): Record<SessionStatus, number>;
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
  operators: OperatorRepository;
  integrationConnections: IntegrationConnectionRepository;
  integrationCredentials: IntegrationCredentialRepository;
}

/** Everything needed to create an operator. The caller has already hashed. */
export interface CreateOperatorInput {
  username: string;
  displayName?: string;
  passwordHash: string;
  role?: Operator['role'];
}

/**
 * Operator identity and dashboard sessions.
 *
 * Separate from `AgentRepository` by design (ADR-044): an operator is a human at
 * the dashboard and an agent is a program at `/mcp`, and no method here can be
 * satisfied by an agent row. The two tables share no foreign key.
 *
 * Session reads are digest-only. There is deliberately no `findByToken`, because
 * the raw token must never be a parameter that reaches a query log or a test
 * snapshot: callers hash first and look up the digest.
 */
export interface OperatorRepository {
  create(input: CreateOperatorInput, now: string): Operator;
  findById(id: string): Operator | undefined;
  /** Case-insensitive exact match; the UNIQUE index stores the canonical form. */
  findByUsername(username: string): Operator | undefined;
  count(): number;
  list(): Operator[];

  /** Replaces the hash and records when, so a login can be invalidated by time. */
  setPassword(id: string, passwordHash: string, now: string): Operator;
  /** Successful login: clears the attempt counter and the lockout. */
  recordLoginSuccess(id: string, now: string): Operator;
  /** Failed login: increments and locks when the threshold is reached. */
  recordLoginFailure(id: string, now: string, lockUntil: string | undefined): Operator;
  disable(id: string, now: string): Operator;

  createSession(session: OperatorSession): OperatorSession;
  findSessionById(id: string): OperatorSession | undefined;
  /** Lookup by digest — the only way a presented cookie is resolved. */
  findSessionByTokenHash(tokenHash: string): OperatorSession | undefined;
  /** Extends the idle clock. No-op for a session that is already ended. */
  touchSession(id: string, now: string): void;
  /** Ends one session. Idempotent; a finished session is returned unchanged. */
  revokeSession(id: string, now: string, reason: OperatorSessionRevocationReason): OperatorSession;
  /** Ends every live session of an operator. Returns the rows that changed. */
  revokeSessionsForOperator(
    operatorId: string,
    now: string,
    reason: OperatorSessionRevocationReason,
  ): OperatorSession[];
  /** Revokes rows past their ceiling or idle deadline. Returns the rows changed. */
  expireSessions(now: string, idleCutoff: string): OperatorSession[];
  countActiveSessions(operatorId: string, now: string, idleCutoff: string): number;
}

/**
 * Managed-integration persistence (Phase 12, ADR-050/051).
 *
 * Connection rows are validated at the service boundary; nothing here stores
 * a credential value — `StoredIntegrationCredential` carries a sealed envelope
 * only. No create/update for providers: the provider registry is code, and a
 * table would be a second copy that can drift (ADR-050).
 */
export interface IntegrationConnectionRepository {
  create(input: IntegrationConnection): IntegrationConnection;
  findById(id: string): IntegrationConnection | undefined;
  list(): IntegrationConnection[];
  /**
   * Status-only write; the service owns transition legality. `validatedAt`
   * records when the status became `connected` (a proved credential, Phase 13);
   * `undefined` leaves the column alone.
   */
  updateStatus(
    id: string,
    status: ConnectionStatus,
    now: string,
    validatedAt?: string,
  ): IntegrationConnection | undefined;
  /** Links (or unlinks with `null`) the vault reference. Value writes go to `IntegrationCredentialRepository`. */
  updateCredential(id: string, credentialId: string | null, now: string): IntegrationConnection | undefined;
  /** Update of operator-facing fields. Status is untouched: use `updateStatus`. */
  update(id: string, fields: { name?: string; metadata?: Record<string, unknown> }, now: string): IntegrationConnection | undefined;
  /** Hard delete; `integration_credentials` rows cascade (migration 0008). */
  remove(id: string): boolean;
}

export interface IntegrationCredentialRepository {
  create(credential: StoredIntegrationCredential): StoredIntegrationCredential;
  findById(id: string): StoredIntegrationCredential | undefined;
  remove(id: string): boolean;
}
