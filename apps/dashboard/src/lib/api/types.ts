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
  attempts: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  updatedAt?: string;
}

export interface DiscoveryReport {
  backendId: string;
  status: 'success' | 'failed' | 'pending';
  toolCount?: number;
  errorCode?: string;
  errorMessage?: string;
  discoveredAt?: string;
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

export interface MonitoringRuntime {
  service: ServiceInfo;
  runtime: { node: string; platform: string; uptimeMs: number };
  timestamp: string;
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

export interface ActivityEvent {
  id: string;
  type: string;
  requestId?: string;
  agentId?: string;
  backendId?: string;
  toolName?: string;
  outcome: 'success' | 'failure' | 'denied';
  errorCode?: string;
  durationMs?: number;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actorType: 'admin' | 'agent' | 'system';
  actorId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  result: 'success' | 'failure' | 'denied';
  requestId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
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
