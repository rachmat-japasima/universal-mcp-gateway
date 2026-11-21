/**
 * Response contracts for the Phase 8 management API.
 *
 * These mirror `docs/API_REFERENCE.md` one-for-one. They are hand-written rather
 * than generated because the gateway's OpenAPI document is produced by
 * `z.toJSONSchema()` and describes *shapes*, not the `null` semantics that
 * matter most here: a storage-backed field is `null` when the read failed, and
 * `0` means "none". A generator would erase that distinction.
 *
 * When the API changes, `tests/api-contract.test.ts` fails: it asserts every
 * response the dashboard relies on against the served OpenAPI document.
 */

/** `null` means "the read failed", which is a different claim from `0`. */
export type Unavailable = null;

export interface ServiceInfo {
  name: string;
  version: string;
}

export interface GatewayHealth {
  status: 'ok';
  service: string;
  version: string;
  timestamp: string;
  mcp: {
    endpoint: string;
    backendCount: number;
    status: 'empty' | 'ready';
    authentication: 'required' | 'unavailable';
  };
}

export interface Readiness {
  status: 'ready' | 'not_ready';
  checks: { database: 'ok' | 'unavailable'; migrations: 'ok' | 'unavailable' };
  migrationVersion?: string;
  timestamp: string;
}

export type BackendRuntimeStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'unhealthy'
  | 'disconnecting'
  | 'error'
  | 'disabled';

/** Display order for distributions; matches the gateway's own state list. */
export const BACKEND_RUNTIME_STATUSES: readonly BackendRuntimeStatus[] = [
  'connected',
  'connecting',
  'disconnecting',
  'disconnected',
  'unhealthy',
  'error',
  'disabled',
];

export interface BackendCounts {
  total: number;
  enabled: number;
  disabled: number;
  runtime: Record<BackendRuntimeStatus, number>;
}

export interface ToolCounts {
  total: number;
  available: number;
  unavailable: number;
  conflict: number;
  backendsWithCatalog: number;
  discoveryFailures: number;
}

export interface AgentCounts {
  total: number;
  enabled: number;
  disabled: number;
}

export type SessionStatus = 'active' | 'expired' | 'terminated' | 'invalidated';
export type SessionCounts = Record<SessionStatus, number>;

export interface ActivityCounts {
  total: number;
  byType: Record<string, number>;
  byOutcome: Record<string, number>;
}

/** `GET /api/v1/overview` — the dashboard landing payload. */
export interface Overview {
  service: ServiceInfo;
  environment: 'development' | 'test' | 'production';
  uptimeMs: number;
  status: 'operational' | 'degraded';
  database: 'ok' | 'unavailable';
  backends: BackendCounts | Unavailable;
  tools: ToolCounts | Unavailable;
  agents: AgentCounts | Unavailable;
  sessions: SessionCounts | Unavailable;
  activity: ActivityCounts | Unavailable;
  authentication: 'required' | 'unavailable';
}

export interface ActivityTotals {
  counts: SessionCounts;
  total: number;
}

export interface Monitoring {
  status: 'operational' | 'degraded';
  service: ServiceInfo;
  runtime: { node: string; platform: string; uptimeMs: number };
  timestamp: string;
  database: 'ok' | 'unavailable';
  backends: BackendCounts | Unavailable;
  sessions: ActivityTotals | Unavailable;
  tools: ToolCounts | Unavailable;
  activity: ActivityCounts | Unavailable;
}

export interface BackendRuntimeView {
  backendId: string;
  status: BackendRuntimeStatus;
  /**
   * Number of automatic reconnect attempts in the current sequence.
   *
   * Named `reconnectAttempts` on the wire (`toView()` in
   * `src/adapters/lifecycle.ts`). This type said `attempts` while nothing read
   * it, which is why it went unnoticed; Phase 10.1 renders it, so it is
   * corrected here to match the served contract.
   */
  reconnectAttempts: number;
  lastConnectedAt?: string;
  lastHealthCheckAt?: string;
  lastErrorCode?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
  updatedAt?: string;
}

export type BackendTransport = 'stdio' | 'streamable-http';

/** A secret reference, never a value: `secret:<path>` or `env:<VAR>` (domain/primitives.ts). */
export type SecretRef = string;

export interface StdioConnection {
  type: 'stdio';
  /** A single executable token. Arguments, never shell syntax. */
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, SecretRef>;
}

export interface StreamableHttpConnection {
  type: 'streamable-http';
  url: string;
  headers: Record<string, SecretRef>;
}

export type BackendConnection = StdioConnection | StreamableHttpConnection;

export type ConcurrencyMode = 'parallel' | 'serialized' | 'limited';

/**
 * A registered backend, as `toPublicBackend()` shapes it.
 *
 * `transport` duplicates `connection.type` because the API sends both; the list
 * filter uses it and the form does, so it is modelled rather than derived.
 */
export interface Backend {
  id: string;
  name: string;
  description?: string;
  transport: BackendTransport;
  connection: BackendConnection;
  enabled: boolean;
  timeoutMs: number;
  concurrencyMode: ConcurrencyMode;
  concurrencyLimit?: number;
  /** Optimistic-concurrency counter; echoed back as `expectedVersion`. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Configuration-visible status only (`services/backend.withRuntime`). */
  runtime?: { status: BackendRuntimeStatus; updatedAt: string };
}

/** `POST /api/v1/backends/validate` — a 200 answer, never a failure. */
export interface BackendValidationResult {
  valid: boolean;
  transport?: string;
  errors?: Array<{ path: string; message: string }>;
  /** Redacted normalised config. Secret references appear; values never exist. */
  normalized?: Record<string, unknown>;
}

export interface BackendQuery {
  page?: number;
  limit?: number;
  search?: string;
  transport?: BackendTransport;
  enabled?: boolean;
  sort?: 'name' | 'createdAt' | 'updatedAt';
  order?: 'asc' | 'desc';
}

/**
 * `GET /api/v1/tools/discovery` and `monitoring/backends.discovery`.
 *
 * Mirrors `discoveryReportSchema` in `src/domain/tool.ts`. `status: 'never'` is
 * a backend no discovery has run for, which is not the same as a failure.
 */
export interface DiscoveryReport {
  backendId: string;
  status: 'never' | 'ok' | 'failed';
  toolCount: number;
  conflictCount: number;
  rejectedCount: number;
  discoveredAt: string;
  /** Sanitized failure summary; never a payload or a credential. */
  lastError?: string;
}

export const TOOL_AVAILABILITIES = ['available', 'unavailable', 'conflict'] as const;
export type ToolAvailability = (typeof TOOL_AVAILABILITIES)[number];

/** `GET /api/v1/tools` and `GET /api/v1/tools/:publicName` — `catalogToolViewSchema`. */
export interface Tool {
  publicName: string;
  originalName: string;
  backendId: string;
  title?: string;
  description?: string;
  /** Opaque JSON Schema, forwarded verbatim from the backend. Never executed here. */
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  availability: ToolAvailability;
  unavailableReason?: string;
  discoveredAt: string;
  updatedAt: string;
}

export interface ToolQuery {
  page?: number;
  limit?: number;
  search?: string;
  backendId?: string;
  availability?: ToolAvailability;
  sort?: 'publicName' | 'backendId' | 'discoveredAt';
  order?: 'asc' | 'desc';
}

/** `POST /api/v1/tools/refresh`. Failures are per backend, in the body. */
export interface ToolRefreshResult {
  refreshed: number;
  failed: number;
  results: Array<{
    backendId: string;
    ok: boolean;
    report?: DiscoveryReport;
    error?: { code: string; message: string };
  }>;
}

export interface ToolConflict {
  publicName: string;
  claimants: Array<{ backendId: string; originalName: string }>;
}

export interface MonitoringBackends {
  counts: BackendCounts | Unavailable;
  runtimes: BackendRuntimeView[];
  discovery: DiscoveryReport[];
  conflicts: ToolConflict[];
}

export interface MonitoringSessions {
  available: boolean;
  counts: SessionCounts | Unavailable;
  total?: number;
  reason?: string;
}

/**
 * `GET /api/v1/monitoring/health` — dependency health as the management API
 * reports it. A different question from `/health` (liveness) and `/ready`
 * (can this process serve): storage answering, and how the backends are doing.
 */
export interface MonitoringHealth {
  status: 'ok' | 'degraded';
  database: 'ok' | 'unavailable';
  backends: BackendCounts | Unavailable;
  timestamp: string;
}

export interface MonitoringRuntime {
  service: ServiceInfo;
  runtime: { node: string; platform: string; uptimeMs: number };
  timestamp: string;
}

/**
 * `GET /api/v1/monitoring/metrics` — the in-memory registry, as JSON.
 *
 * The registry resets on restart, so these are current facts, not history:
 * counters since process start, no derived rates, no trend lines. `samples` are
 * `Record<string, unknown>` on the wire (counter/gauge samples carry `value`,
 * histogram samples carry `count`/`sum`/`buckets`), so the card reads the one
 * field it wants instead of re-declaring every family's shape.
 */
export interface MonitoringMetrics {
  generatedAt: string;
  series: number;
  dropped: number;
  metrics: Array<{
    name: string;
    type: 'counter' | 'gauge' | 'histogram';
    help: string;
    samples: Array<Record<string, unknown>>;
  }>;
  recentErrors: Array<{ code: string; component: string; at: string; requestId?: string }>;
}

export interface Diagnostics {
  service: ServiceInfo;
  runtime: { node: string; platform: string; uptimeMs: number };
  timestamp: string;
  database: { status: 'ok' | 'unavailable'; migrationVersion: string | null };
  configuration: { status: 'ok'; environment: string; logLevel: string };
  backends: { registered: number | null };
  sessions: { total: number } | null;
  tools: { available: number | null };
  authentication: 'required' | 'unavailable';
  limits: { requestBodyLimitBytes: number; requestTimeoutMs: number };
}

export interface Settings {
  environment: string;
  host: string;
  port: number;
  endpoints: { mcp: string; health: string; api: string };
  logging: { level: string };
  limits: {
    requestBodyLimitBytes: number;
    requestTimeoutMs: number;
    toolDiscoveryTimeoutMs: number;
    toolCallTimeoutMs: number;
  };
  sessions: { idleTimeoutMs: number; maxLifetimeMs: number };
  backendConnections: {
    reconnect: {
      enabled: boolean;
      initialDelayMs: number;
      maxDelayMs: number;
      maxAttempts: number;
      jitterRatio: number;
    };
    allowPrivateNetwork: boolean;
  };
  features: {
    authentication: boolean;
    sessions: boolean;
    toolRouting: boolean;
    backendLifecycle: boolean;
    auditTrail: boolean;
    settingsMutation: boolean;
    metrics: boolean;
  };
  readOnly: true;
}

export interface ActivityTypeCounts {
  [type: string]: number;
}

/**
 * `ACTIVITY_TYPES` in `src/domain/activity-event.ts`. Operational history:
 * "what did the gateway do?". Deliberately a different vocabulary from audit —
 * a filter value from one is a `400` on the other.
 */
export const ACTIVITY_TYPES = [
  'mcp.initialize',
  'tools.list',
  'tools.call',
  'backend.connected',
  'backend.disconnected',
  'backend.error',
  'request.failed',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_OUTCOMES = ['success', 'failure', 'denied'] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

/** `GET /api/v1/activity` — every field is stored, none derived. */
export interface ActivityEvent {
  id: string;
  type: ActivityType;
  requestId?: string;
  agentId?: string;
  backendId?: string;
  toolName?: string;
  outcome: ActivityOutcome;
  /** A stable `ErrorCode`, never a free-form message. */
  errorCode?: string;
  durationMs?: number;
  createdAt: string;
}

/** `AUDIT_ACTIONS` in `src/domain/audit-event.ts`. */
export const AUDIT_ACTIONS = [
  'backend.created',
  'backend.updated',
  'backend.deleted',
  'backend.enabled',
  'backend.disabled',
  'backend.validation_failed',
  'agent.created',
  'agent.updated',
  'agent.enabled',
  'agent.disabled',
  'agent.deleted',
  'credential.created',
  'credential.rotated',
  'credential.revoked',
  'policy.created',
  'policy.updated',
  'policy.deleted',
  'policy.assigned',
  'policy.unassigned',
  'session.revoked',
  'session.created',
  'session.authenticated',
  'session.access.denied',
  'session.expired',
  'session.terminated',
  'session.invalidated',
  'session.cleanup.completed',
  'settings.updated',
  'auth.succeeded',
  'auth.failed',
  'access.denied',
  'operator.login.succeeded',
  'operator.login.failed',
  'operator.logout',
  'operator.session.revoked',
  'operator.session.expired',
  'operator.created',
  'operator.disabled',
  'operator.password_changed',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTORS = ['admin', 'agent', 'system'] as const;
export type AuditActorType = (typeof AUDIT_ACTORS)[number];

export const AUDIT_RESULTS = ['success', 'failure', 'denied'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

/**
 * `targetType` is narrowed to the values `listAuditQuerySchema` accepts — note it
 * omits `operator`, which the event schema allows but the list filter does not.
 * Offering it in a filter menu would earn a `400`.
 */
export const AUDIT_TARGET_TYPES = ['backend', 'agent', 'credential', 'policy', 'session', 'settings'] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * A row from `GET /api/v1/audit`. The list **omits `metadata`** on purpose
 * (`toAuditListItem`), so metadata is only reachable from the detail read — the
 * deliberate disclosure boundary. `targetType` is optional here: the schema
 * allows an event with no target.
 */
export interface AuditEvent {
  id: string;
  actorType: AuditActorType;
  actorId?: string;
  action: AuditAction;
  targetType?: AuditTargetType | 'operator';
  targetId?: string;
  result: AuditResult;
  requestId?: string;
  metadata?: Record<string, string | number | boolean>;
  createdAt: string;
}

/**
 * `GET /api/v1/activity` filters, exactly as `listActivityQuerySchema` defines
 * them. `type` and `outcome` are closed enums, so a free-form value could only
 * produce a `400`.
 */
export interface ActivityQuery {
  page?: number;
  limit?: number;
  type?: ActivityType;
  outcome?: ActivityOutcome;
  agentId?: string;
  backendId?: string;
  toolName?: string;
  search?: string;
  after?: string;
  before?: string;
  order?: 'asc' | 'desc';
}

/**
 * `GET /api/v1/audit` filters. Note `targetType` is the *list* enum, which omits
 * `operator` even though an event may carry it.
 */
export interface AuditQuery {
  page?: number;
  limit?: number;
  action?: AuditAction;
  actorType?: AuditActorType;
  actorId?: string;
  targetType?: AuditTargetType;
  targetId?: string;
  result?: AuditResult;
  search?: string;
  after?: string;
  before?: string;
  order?: 'asc' | 'desc';
}

/** Every list response carries this. `total` is measured over the filtered set. */
export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Page<T> {
  data: T[];
  pagination: Pagination;
}

/** The fixed `ErrorCode` set from `src/shared/errors.ts`. */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'RESOURCE_NOT_FOUND',
  'RESOURCE_CONFLICT',
  'AUTHENTICATION_ERROR',
  'AUTHORIZATION_ERROR',
  'MCP_PROTOCOL_ERROR',
  'TOOL_NOT_FOUND',
  'TOOL_UNAVAILABLE',
  'TOOL_CANCELLED',
  'BACKEND_CONNECTION_ERROR',
  'BACKEND_TIMEOUT',
  'BACKEND_UNAVAILABLE',
  'DATABASE_ERROR',
  'CONFIGURATION_ERROR',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; requestId: string };
}

// --- Agents and credentials (Phase 10.3) ---------------------------------

/** `CLIENT_TYPES` in `src/domain/agent.ts`. Display metadata only, never an authz input. */
export const CLIENT_TYPES = [
  'claude-code',
  'codex-cli',
  'opencode',
  'deepseek',
  'deepseek-desktop',
  'other',
] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

/**
 * `toPublicAgent()` in `src/registry/agent-service.ts`.
 *
 * `status` is derived from `enabled` on the server; both are present so the UI
 * never has to compute one from the other and risk disagreeing.
 */
export interface Agent {
  id: string;
  name: string;
  description?: string;
  clientType?: ClientType;
  enabled: boolean;
  status: 'active' | 'disabled';
  metadata?: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
  /** Set the first time a credential of this agent authenticates. */
  lastAuthenticatedAt?: string;
}

export interface AgentQuery {
  page?: number;
  limit?: number;
  search?: string;
  enabled?: boolean;
  status?: 'active' | 'disabled';
  clientType?: string;
  sort?: 'name' | 'createdAt' | 'updatedAt';
  order?: 'asc' | 'desc';
}

/** `createAgentSchema` / `updateAgentSchema`. */
export interface AgentCreateInput {
  name: string;
  description?: string;
  clientType?: ClientType;
  metadata?: Record<string, string | number | boolean>;
  enabled?: boolean;
}

export interface AgentUpdateInput {
  name?: string;
  /** `null` clears it; `undefined` leaves it. */
  description?: string | null;
  clientType?: ClientType | null;
  /** Replaces the whole map; there is no partial merge. */
  metadata?: Record<string, string | number | boolean> | null;
  enabled?: boolean;
}

/**
 * `toPublicCredential()` — public metadata only.
 *
 * No token, no digest, and nothing derived from one beyond the display prefix
 * and the key id. `status` is derived server-side from `revokedAt`/`expiresAt`.
 */
export interface AgentCredential {
  id: string;
  agentId: string;
  name?: string;
  tokenPrefix?: string;
  hashKeyId?: string;
  status: 'active' | 'expired' | 'revoked';
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

/**
 * The one response that carries a raw token, from `POST …/credentials` and
 * `POST …/credentials/:id/rotate`.
 *
 * Held in component state only, for as long as the panel is open. It is never
 * written to storage, a URL, a log, or an audit field — and the gateway cannot
 * return it again.
 */
export interface IssuedCredential extends AgentCredential {
  token: string;
}

/** `GET /agents/:agentId/access` — computed by `AuthorizationService.describeAccess`. */
export interface AgentAccess {
  agentId: string;
  policies: Array<{ id: string; name: string; priority: number }>;
  visibleTools: Array<{ publicName: string; backendId: string; allowed: boolean; reason: string }>;
}

/**
 * Policy contracts (Phase 10.4) — mirrored from `src/domain/policy.ts`.
 *
 * `rules` is the whole policy: there is no separate rule resource, so a rule is
 * edited by sending the full array back. Both fields are closed enums on the
 * gateway (`.strict()`), so a typo cannot become a silently ignored rule.
 */
export const POLICY_EFFECTS = ['allow', 'deny'] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

export const POLICY_RESOURCES = ['backend', 'tool'] as const;
export type PolicyResource = (typeof POLICY_RESOURCES)[number];

/**
 * `target` is `*` (matches everything at that level) or an exact identifier:
 * a backend uuid for `resource: 'backend'`, a public tool name for `'tool'`.
 */
export interface PolicyRule {
  resource: PolicyResource;
  target: string;
  effect: PolicyEffect;
}

export interface Policy {
  id: string;
  name: string;
  description?: string;
  /** Evaluation order across an agent's policies. Higher wins; ties go to deny. */
  priority: number;
  rules: PolicyRule[];
  createdAt: string;
  updatedAt: string;
}

export interface PolicyQuery {
  page?: number;
  limit?: number;
  search?: string;
  /** Matters at least one rule with this effect. */
  effect?: PolicyEffect;
  agentId?: string;
  backendId?: string;
  sort?: 'name' | 'createdAt' | 'updatedAt' | 'priority';
  order?: 'asc' | 'desc';
}

export interface PolicyCreateInput {
  name: string;
  description?: string;
  priority?: number;
  rules?: PolicyRule[];
}

/** `undefined` keeps a field; `description: null` clears it. */
export interface PolicyUpdateInput {
  name?: string;
  description?: string | null;
  priority?: number;
  rules?: PolicyRule[];
}

// --- MCP sessions (Phase 10.5) -------------------------------------------

/**
 * `SESSION_STATUSES` in `src/domain/session.ts`.
 *
 * These are **MCP agent sessions**, not dashboard operator sessions. The two are
 * separate tables and separate domains; nothing on this screen reads
 * `operator_sessions`.
 */
export const SESSION_STATUSES = ['active', 'expired', 'terminated', 'invalidated'] as const;

/** `SESSION_TERMINATION_REASONS` in `src/domain/session.ts`. */
export const SESSION_TERMINATION_REASONS = [
  'operator_terminated',
  'client_deleted',
  'idle_timeout',
  'max_lifetime',
  'agent_disabled',
  'agent_deleted',
  'credential_revoked',
  'credential_rotated',
  'gateway_shutdown',
  'transport_lost',
  'cleanup',
] as const;
export type SessionTerminationReason = (typeof SESSION_TERMINATION_REASONS)[number];

/** `toPublicSession()` in `src/registry/session-service.ts` — no token, ever. */
export interface Session {
  id: string;
  /** Protocol session id: a routing handle that proves nothing on its own. */
  mcpSessionId?: string;
  agentId: string;
  /** The credential that authenticated initialization. An id, never a token. */
  credentialId?: string;
  status: SessionStatus;
  createdAt: string;
  lastActivityAt: string;
  /** Hard cap: `createdAt` + the configured maximum lifetime. */
  expiresAt?: string;
  terminatedAt?: string;
  terminationReason?: SessionTerminationReason;
  /** Non-secret client facts recorded at initialization. */
  metadata?: {
    clientType?: string;
    clientVersion?: string;
    protocolVersion?: string;
    remoteAddress?: string;
  };
}

/**
 * `listSessionsQuerySchema`. Deliberately no `search` and no session-id filter:
 * the gateway answers by id at `GET /sessions/:sessionId`, so an id lookup is a
 * detail read rather than an invented list parameter.
 */
export interface SessionQuery {
  page?: number;
  limit?: number;
  agentId?: string;
  status?: SessionStatus;
  createdAfter?: string;
  createdBefore?: string;
  lastActivityAfter?: string;
  sort?: 'createdAt' | 'lastActivityAt';
  order?: 'asc' | 'desc';
}

/**
 * Managed integrations (Phase 13). The provider list is code-registered — no
 * marketplace, no plugins — so a short list is the whole truth, and GitHub is
 * the first registered provider (ADR-053).
 */
export interface IntegrationProvider {
  /** Registry key: a lowercase slug, stable once published. */
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  metadata: Record<string, unknown>;
  registeredAt: string;
}

export const INTEGRATION_STATUSES = [
  'pending',
  'connecting',
  'connected',
  'disconnected',
  'error',
  'reauthorization_required',
  'disabled',
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export interface IntegrationConnection {
  id: string;
  providerId: string;
  /** Present while the provider stays registered. */
  providerName?: string;
  name: string;
  status: IntegrationStatus;
  /** Vault reference, never a value. `null` when no credential is stored. */
  credentialId: string | null;
  metadata: Record<string, unknown>;
  /**
   * When the credential was last proved against the provider. `null` until
   * the first successful connect — storing a token proves nothing.
   */
  validatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET …/connections/:id/tools` — the same vocabulary as `Tool`, but the
 * source is a managed integration, not a registered backend, so the source
 * fields differ and the dashboard must not reuse the backend-typed view.
 */
export interface IntegrationTool {
  publicName: string;
  originalName: string;
  sourceType: 'managed_integration';
  sourceId: string;
  title?: string;
  description?: string;
  /** Opaque JSON Schema, forwarded verbatim from the provider. Never executed here. */
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  availability: ToolAvailability;
  discoveredAt: string;
  updatedAt: string;
}

/** `POST …/test` — the handshake answer as data, never an error envelope. */
export type IntegrationVerifyResult =
  | { ok: true }
  | {
      ok: false;
      kind: 'invalid_request' | 'reauthorization_required' | 'unreachable' | 'provider_error';
      /** The connector vocabulary; never provider prose. */
      message: string;
    };

/** `POST …/enable` — the committed row plus what the catalog learned. */
export interface IntegrationEnableResult {
  connection: IntegrationConnection;
  tools: { added: string[]; removed: string[]; changed: string[] };
}
