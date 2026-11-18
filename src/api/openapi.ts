import { z } from 'zod';

import type { Config } from '../config/config.js';
import { SERVICE_INFO } from '../shared/service.js';
import { listActivityQuerySchema, listAuditQuerySchema, listSessionsQuerySchema } from './schemas/queries.js';

/**
 * OpenAPI 3.1 document for the management API.
 *
 * Built from a literal description rather than reflection, because a generated
 * document would describe the *schemas* and not the routes: Hono exposes no
 * typed route metadata, so a generator would have to guess which schema belongs
 * to which handler. Instead the route table below is checked against the live
 * app in `tests/openapi.test.ts` — a documented path that does not exist, or a
 * live path that is undocumented, fails the build.
 *
 * Query parameters are derived from the same Zod schemas the handlers parse, so
 * a bound or an enum can never drift between the document and the validator.
 *
 * No new dependency: `z.toJSONSchema` ships with Zod 4.
 */

const ref = (name: string): Record<string, unknown> => ({ $ref: `#/components/schemas/${name}` });

/** Query parameters from a Zod object schema. */
function queryParameters(schema: z.ZodType): Array<Record<string, unknown>> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };

  return Object.entries(json.properties ?? {}).map(([name, property]) => ({
    name,
    in: 'query',
    required: json.required?.includes(name) ?? false,
    schema: property,
  }));
}

/** A documented failure. The envelope is identical for every code; only status differs. */
function errorResponses(...statuses: Array<[string, string]>): Record<string, unknown> {
  return Object.fromEntries(
    statuses.map(([status, description]) => [
      status,
      { description, content: { 'application/json': { schema: ref('ErrorEnvelope') } } },
    ]),
  );
}

const pathParam = (name: string, format?: string): Record<string, unknown> => ({
  name,
  in: 'path',
  required: true,
  schema: format === 'uuid' ? { type: 'string', format: 'uuid' } : { type: 'string', minLength: 1, maxLength: 200 },
});

const jsonBody = (schema: Record<string, unknown>): Record<string, unknown> => ({
  required: true,
  content: { 'application/json': { schema } },
});

const okBody = (data: Record<string, unknown>, description = 'Success'): Record<string, unknown> => ({
  description,
  content: {
    'application/json': {
      schema: { type: 'object', required: ['data'], properties: { data }, additionalProperties: true },
    },
  },
});

/** A list response: `data` is an array and `pagination` is always present. */
const listBody = (items: Record<string, unknown>): Record<string, unknown> => ({
  description: 'A page of results',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['data', 'pagination'],
        properties: { data: { type: 'array', items }, pagination: ref('Pagination') },
        additionalProperties: false,
      },
    },
  },
});

const uuid = (description: string): Record<string, unknown> => ({ type: 'string', format: 'uuid', description });
const instant = (description: string): Record<string, unknown> => ({
  type: 'string',
  format: 'date-time',
  description,
});

function schemas(): Record<string, unknown> {
  const backendConnection = {
    type: 'object',
    description: 'Transport-specific configuration. Secret references are `env:`/`secret:` names, never values.',
    required: ['type'],
    properties: {
      type: { type: 'string', enum: ['stdio', 'streamable-http'] },
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      cwd: { type: 'string' },
      url: { type: 'string' },
      env: { type: 'object', additionalProperties: { type: 'string' } },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
    },
    additionalProperties: true,
  };

  return {
    ErrorEnvelope: {
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: {
              type: 'string',
              enum: [
                'VALIDATION_ERROR',
                'CONFIGURATION_ERROR',
                'AUTHENTICATION_ERROR',
                'AUTHORIZATION_ERROR',
                'RESOURCE_NOT_FOUND',
                'RESOURCE_CONFLICT',
                'MCP_PROTOCOL_ERROR',
                'BACKEND_CONNECTION_ERROR',
                'BACKEND_TIMEOUT',
                'BACKEND_UNAVAILABLE',
                'TOOL_NOT_FOUND',
                'TOOL_UNAVAILABLE',
                'TOOL_CANCELLED',
                'DATABASE_ERROR',
                'INTERNAL_ERROR',
              ],
            },
            message: { type: 'string' },
            requestId: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    Pagination: {
      type: 'object',
      required: ['page', 'limit', 'total', 'totalPages'],
      properties: {
        page: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        total: { type: 'integer', minimum: 0 },
        totalPages: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    Backend: {
      type: 'object',
      required: ['id', 'name', 'transport', 'connection', 'enabled', 'timeoutMs', 'concurrencyMode', 'version', 'createdAt', 'updatedAt'],
      properties: {
        id: uuid('Backend id.'),
        name: { type: 'string' },
        description: { type: 'string' },
        transport: { type: 'string', enum: ['stdio', 'streamable-http'] },
        connection: backendConnection,
        enabled: { type: 'boolean' },
        timeoutMs: { type: 'integer' },
        concurrencyMode: { type: 'string', enum: ['unlimited', 'limited'] },
        concurrencyLimit: { type: 'integer' },
        version: { type: 'integer', description: 'Optimistic concurrency version.' },
        createdAt: instant('Created at.'),
        updatedAt: instant('Updated at.'),
        runtime: {
          type: 'object',
          description: 'Present when a runtime row exists. Never implies a live connection.',
          required: ['status', 'updatedAt'],
          properties: { status: { type: 'string' }, updatedAt: instant('Updated at.') },
          additionalProperties: true,
        },
      },
      additionalProperties: false,
    },
    RuntimeView: {
      type: 'object',
      required: ['backendId', 'status', 'reconnectAttempts', 'updatedAt'],
      properties: {
        backendId: uuid('Backend id.'),
        status: {
          type: 'string',
          enum: ['disconnected', 'connecting', 'connected', 'unhealthy', 'disconnecting', 'error', 'disabled'],
        },
        lastConnectedAt: instant('Last successful connection.'),
        lastHealthCheckAt: instant('Last health check.'),
        lastErrorCode: { type: 'string' },
        lastErrorAt: instant('Last error time.'),
        lastErrorMessage: { type: 'string', description: 'Sanitized for display.' },
        reconnectAttempts: { type: 'integer', minimum: 0 },
        uptimeMs: { type: 'integer', description: 'Present only while a connection is live.' },
        updatedAt: instant('Updated at.'),
      },
      additionalProperties: false,
    },
    Agent: {
      type: 'object',
      required: ['id', 'name', 'enabled', 'status', 'createdAt', 'updatedAt'],
      properties: {
        id: uuid('Agent id.'),
        name: { type: 'string' },
        description: { type: 'string' },
        clientType: { type: 'string' },
        enabled: { type: 'boolean' },
        status: { type: 'string', enum: ['active', 'disabled'] },
        metadata: { type: 'object', additionalProperties: { type: 'string' } },
        createdAt: instant('Created at.'),
        updatedAt: instant('Updated at.'),
        lastAuthenticatedAt: instant('Last successful credential authentication.'),
      },
      additionalProperties: false,
    },
    Credential: {
      type: 'object',
      required: ['id', 'agentId', 'status', 'createdAt'],
      properties: {
        id: uuid('Credential id.'),
        agentId: uuid('Owning agent id.'),
        name: { type: 'string' },
        tokenPrefix: { type: 'string', description: 'First characters of the token, for recognition only.' },
        hashKeyId: { type: 'string' },
        status: { type: 'string', enum: ['active', 'expired', 'revoked'] },
        createdAt: instant('Created at.'),
        expiresAt: instant('Expiry.'),
        lastUsedAt: instant('Last use.'),
        revokedAt: instant('Revocation time.'),
      },
      additionalProperties: false,
    },
    CredentialIssued: {
      allOf: [ref('Credential')],
      description: 'A credential plus its raw token. The token is returned once and never stored.',
      properties: { token: { type: 'string' } },
    },
    Policy: {
      type: 'object',
      required: ['id', 'name', 'priority', 'rules', 'createdAt', 'updatedAt'],
      properties: {
        id: uuid('Policy id.'),
        name: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'integer', minimum: -1000, maximum: 1000 },
        rules: {
          type: 'array',
          items: {
            type: 'object',
            required: ['resource', 'target', 'effect'],
            properties: {
              resource: { type: 'string', enum: ['backend', 'tool'] },
              target: { type: 'string', description: 'A backend id, a public tool name, or `*`.' },
              effect: { type: 'string', enum: ['allow', 'deny'] },
            },
            additionalProperties: false,
          },
        },
        createdAt: instant('Created at.'),
        updatedAt: instant('Updated at.'),
      },
      additionalProperties: false,
    },
    Session: {
      type: 'object',
      required: ['id', 'agentId', 'status', 'createdAt', 'lastActivityAt'],
      properties: {
        id: uuid('Internal session id. Never sent to an MCP client.'),
        mcpSessionId: { type: 'string', description: 'Protocol session id. A routing handle, not a credential.' },
        agentId: uuid('Owning agent id.'),
        credentialId: uuid('Credential that authenticated the session.'),
        status: { type: 'string', enum: ['active', 'expired', 'terminated', 'invalidated'] },
        createdAt: instant('Created at.'),
        lastActivityAt: instant('Last activity.'),
        expiresAt: instant('Hard lifetime cap.'),
        terminatedAt: instant('Termination time.'),
        terminationReason: {
          type: 'string',
          enum: [
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
          ],
        },
        metadata: {
          type: 'object',
          properties: {
            clientType: { type: 'string' },
            clientVersion: { type: 'string' },
            protocolVersion: { type: 'string' },
            remoteAddress: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    Tool: {
      type: 'object',
      required: ['publicName', 'originalName', 'backendId', 'inputSchema', 'availability', 'discoveredAt', 'updatedAt'],
      properties: {
        publicName: { type: 'string', description: 'Namespaced, routing name.' },
        originalName: { type: 'string' },
        backendId: uuid('Owning backend id.'),
        title: { type: 'string' },
        description: { type: 'string' },
        inputSchema: { type: 'object', description: 'Forwarded verbatim from the backend.' },
        outputSchema: { type: 'object' },
        annotations: { type: 'object' },
        availability: { type: 'string', enum: ['available', 'unavailable', 'conflict'] },
        unavailableReason: { type: 'string' },
        discoveredAt: instant('Discovered at.'),
        updatedAt: instant('Updated at.'),
      },
      additionalProperties: false,
    },
    DiscoveryReport: {
      type: 'object',
      required: ['backendId', 'status', 'toolCount', 'conflictCount', 'rejectedCount', 'discoveredAt'],
      properties: {
        backendId: uuid('Backend id.'),
        status: { type: 'string', enum: ['never', 'ok', 'failed'] },
        toolCount: { type: 'integer', minimum: 0 },
        conflictCount: { type: 'integer', minimum: 0 },
        rejectedCount: { type: 'integer', minimum: 0 },
        discoveredAt: instant('Discovered at.'),
        lastError: { type: 'string' },
      },
      additionalProperties: false,
    },
    ActivityEvent: {
      type: 'object',
      required: ['id', 'type', 'outcome', 'createdAt'],
      properties: {
        id: uuid('Event id.'),
        type: {
          type: 'string',
          enum: ['mcp.initialize', 'tools.list', 'tools.call', 'backend.connected', 'backend.disconnected', 'backend.error', 'request.failed'],
        },
        requestId: { type: 'string' },
        agentId: uuid('Agent id.'),
        backendId: uuid('Backend id.'),
        toolName: { type: 'string' },
        outcome: { type: 'string', enum: ['success', 'failure', 'denied'] },
        errorCode: { type: 'string' },
        durationMs: { type: 'integer', minimum: 0 },
        createdAt: instant('Recorded at.'),
      },
      additionalProperties: false,
    },
    AuditEvent: {
      type: 'object',
      required: ['id', 'actorType', 'action', 'result', 'createdAt'],
      properties: {
        id: uuid('Event id.'),
        actorType: { type: 'string', enum: ['admin', 'agent', 'system'] },
        actorId: { type: 'string' },
        action: { type: 'string', description: 'One of the fixed `AUDIT_ACTIONS` values.' },
        targetType: { type: 'string', enum: ['backend', 'agent', 'credential', 'policy', 'session', 'settings'] },
        targetId: { type: 'string' },
        result: { type: 'string', enum: ['success', 'failure', 'denied'] },
        requestId: { type: 'string' },
        metadata: {
          type: 'object',
          description: 'Flat, bounded, non-secret context. Rendered only by the detail endpoint.',
          additionalProperties: { type: ['string', 'number', 'boolean'] },
        },
        createdAt: instant('Recorded at.'),
      },
      additionalProperties: false,
    },
    Overview: {
      type: 'object',
      required: ['service', 'environment', 'uptimeMs', 'status', 'database', 'tools', 'authentication'],
      properties: {
        service: { type: 'object', properties: { name: { type: 'string' }, version: { type: 'string' } } },
        environment: { type: 'string', enum: ['development', 'test', 'production'] },
        uptimeMs: { type: 'integer', minimum: 0 },
        status: { type: 'string', enum: ['operational', 'degraded'] },
        database: { type: 'string', enum: ['ok', 'unavailable'] },
        backends: {
          type: ['object', 'null'],
          description: '`null` when the database is unavailable — distinct from zero.',
          properties: {
            total: { type: 'integer' },
            enabled: { type: 'integer' },
            disabled: { type: 'integer' },
            runtime: { type: 'object', additionalProperties: { type: 'integer' } },
          },
        },
        tools: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            available: { type: 'integer' },
            unavailable: { type: 'integer' },
            conflict: { type: 'integer' },
            backendsWithCatalog: { type: 'integer' },
            discoveryFailures: { type: 'integer' },
          },
        },
        agents: {
          type: ['object', 'null'],
          properties: { total: { type: 'integer' }, enabled: { type: 'integer' }, disabled: { type: 'integer' } },
        },
        sessions: {
          type: ['object', 'null'],
          properties: {
            active: { type: 'integer' },
            expired: { type: 'integer' },
            terminated: { type: 'integer' },
            invalidated: { type: 'integer' },
          },
        },
        activity: {
          type: ['object', 'null'],
          properties: {
            total: { type: 'integer' },
            byType: { type: 'object', additionalProperties: { type: 'integer' } },
            byOutcome: { type: 'object', additionalProperties: { type: 'integer' } },
          },
        },
        authentication: { type: 'string', enum: ['required', 'unavailable'] },
      },
    },
    Settings: {
      type: 'object',
      description: 'Effective, non-secret configuration. Read-only.',
      required: ['environment', 'host', 'port', 'readOnly'],
      properties: {
        environment: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'integer' },
        endpoints: { type: 'object', additionalProperties: { type: 'string' } },
        logging: { type: 'object', properties: { level: { type: 'string' } } },
        limits: { type: 'object', additionalProperties: { type: 'integer' } },
        sessions: { type: 'object', additionalProperties: { type: 'integer' } },
        backendConnections: { type: 'object', additionalProperties: true },
        features: { type: 'object', additionalProperties: { type: 'boolean' } },
        readOnly: { type: 'boolean', enum: [true] },
      },
    },
  };
}

const BACKEND_CREATE = {
  type: 'object',
  required: ['name', 'connection'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string' },
    connection: { $ref: '#/components/schemas/Backend/properties/connection' },
    timeoutMs: { type: 'integer' },
    concurrencyMode: { type: 'string', enum: ['unlimited', 'limited'] },
    concurrencyLimit: { type: 'integer' },
    enabled: { type: 'boolean' },
  },
  additionalProperties: false,
};

const AGENT_CREATE = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string' },
    clientType: { type: 'string' },
    metadata: { type: 'object', additionalProperties: { type: 'string' } },
    enabled: { type: 'boolean' },
  },
  additionalProperties: false,
};

const POLICY_CREATE = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string' },
    priority: { type: 'integer', minimum: -1000, maximum: 1000 },
    rules: { $ref: '#/components/schemas/Policy/properties/rules' },
  },
  additionalProperties: false,
};

const CREDENTIAL_ISSUE = {
  type: 'object',
  properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, expiresAt: { type: 'string', format: 'date-time' } },
  additionalProperties: false,
};

const BACKEND_ID = pathParam('backendId', 'uuid');
const AGENT_ID = pathParam('agentId', 'uuid');
const POLICY_ID = pathParam('policyId', 'uuid');
const SESSION_ID = pathParam('sessionId', 'uuid');
const EVENT_ID = pathParam('eventId', 'uuid');
const EXPECTED_VERSION = {
  name: 'expectedVersion',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 1 },
};

export function buildOpenApi(config: Config): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: `${SERVICE_INFO.name} management API`,
      version: SERVICE_INFO.version,
      description: [
        'Local operator API for the Universal MCP Gateway.',
        '',
        '**Trust boundary.** Every route here is loopback-only and unauthenticated:',
        'the local operator is the only principal. There is no remote administrator',
        'authentication yet, so this API must not be exposed beyond `127.0.0.1`.',
        'The MCP surface at `/mcp` is separate and *is* authenticated per request with',
        'an agent bearer token.',
        '',
        '**Envelopes.** Success is `{ "data": ... }` with `pagination` on lists;',
        'failure is `{ "error": { code, message, requestId } }`.',
        '',
        '**Pagination** is `page`/`limit` (1-based), `limit` at most 100, deterministic',
        'ordering, `total` + `totalPages` returned. Filters and sort fields are',
        'allowlisted enums; an unknown value is a `400`.',
      ].join('\n'),
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'system', description: 'Service facts, health, readiness, diagnostics.' },
      { name: 'backends', description: 'Backend registry and lifecycle.' },
      { name: 'tools', description: 'Discovered tool catalog. Management visibility only — agent access is authorised by policy.' },
      { name: 'agents', description: 'Agent profiles and credentials.' },
      { name: 'policies', description: 'Access policies and effective access.' },
      { name: 'sessions', description: 'Persisted MCP sessions.' },
      { name: 'activity', description: 'Operational history. Not the security audit trail.' },
      { name: 'audit', description: 'Administrative and security history. Append-only.' },
      { name: 'monitoring', description: 'Operational metrics from live state.' },
      { name: 'meta', description: 'API documentation and settings.' },
    ],
    components: {
      schemas: schemas(),
      securitySchemes: {
        agentBearer: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Agent credential for the MCP surface. Issued once by `POST /api/v1/agents/{agentId}/credentials`; the raw token is never retrievable afterwards.',
        },
      },
    },
    security: [],
    paths: {
      '/health': {
        get: {
          tags: ['system'],
          summary: 'Liveness probe',
          description:
            'Answers while the process can serve. Deliberately does not fail when a backend is disconnected or authentication is unconfigured. Not under `/api/v1`.',
          responses: { 200: { description: 'Process is alive' } },
        },
      },

      '/api/v1/system': {
        get: {
          tags: ['system'],
          summary: 'Service identity and counts',
          responses: { 200: okBody({ type: 'object' }), ...errorResponses(['400', 'Authorization rejected']) },
        },
      },
      '/api/v1/system/health': {
        get: {
          tags: ['system'],
          summary: 'Management-plane health',
          responses: { 200: okBody({ type: 'object' }) },
        },
      },
      '/api/v1/overview': {
        get: {
          tags: ['system'],
          summary: 'Dashboard overview',
          description: 'One read of every aggregate a dashboard home screen shows. `null` means unavailable, never zero.',
          responses: { 200: okBody(ref('Overview')), ...errorResponses(['500', 'Internal error']) },
        },
      },
      '/ready': {
        get: {
          tags: ['system'],
          summary: 'Readiness probe',
          description:
            'Checks required local infrastructure: the database answers and the migration ledger is readable. Optional backends are excluded by design.',
          responses: {
            200: { description: 'Ready' },
            503: { description: 'Not ready' },
          },
        },
      },
      '/api/v1/diagnostics': {
        get: {
          tags: ['system'],
          summary: 'Safe diagnostic facts',
          description: 'Version, runtime, uptime, database and migration state, configuration validation. Never environment variable values.',
          responses: { 200: okBody({ type: 'object' }) },
        },
      },
      '/api/v1/settings': {
        get: {
          tags: ['meta'],
          summary: 'Effective non-secret settings',
          description: 'Read-only. No secret, token, or credential material is reachable from configuration.',
          responses: { 200: okBody(ref('Settings')) },
        },
      },
      '/api/v1/openapi.json': {
        get: {
          tags: ['meta'],
          summary: 'This document',
          responses: { 200: { description: 'OpenAPI 3.1 specification' } },
        },
      },

      '/api/v1/backends': {
        get: {
          tags: ['backends'],
          summary: 'List backends',
          parameters: queryParameters(
            z.object({
              page: z.number().int().min(1).default(1),
              limit: z.number().int().min(1).max(100).default(20),
              search: z.string().optional(),
              transport: z.enum(['stdio', 'streamable-http']).optional(),
              enabled: z.enum(['true', 'false']).optional(),
              sort: z.enum(['name', 'createdAt', 'updatedAt']).default('name'),
              order: z.enum(['asc', 'desc']).default('asc'),
            }),
          ),
          responses: { 200: listBody(ref('Backend')), ...errorResponses(['400', 'Invalid query']) },
        },
        post: {
          tags: ['backends'],
          summary: 'Register a backend',
          description: 'Registers and creates a resting runtime row. Never connects.',
          requestBody: jsonBody(BACKEND_CREATE),
          responses: {
            201: okBody(ref('Backend'), 'Created'),
            ...errorResponses(['400', 'Invalid body'], ['409', 'Name already exists']),
          },
        },
      },
      '/api/v1/backends/validate': {
        post: {
          tags: ['backends'],
          summary: 'Validate a backend configuration',
          description:
            'Returns per-field issues in a `200`. Does not connect, does not persist, and never resolves secrets to values.',
          requestBody: jsonBody({ type: 'object' }),
          responses: { 200: okBody({ type: 'object' }) },
        },
      },
      '/api/v1/backends/runtime': {
        get: {
          tags: ['backends'],
          summary: 'Every backend runtime state',
          responses: { 200: okBody({ type: 'array', items: ref('RuntimeView') }) },
        },
      },
      '/api/v1/backends/{backendId}': {
        get: {
          tags: ['backends'],
          summary: 'Get a backend',
          parameters: [BACKEND_ID],
          responses: { 200: okBody(ref('Backend')), ...errorResponses(['400', 'Invalid id'], ['404', 'Not found']) },
        },
        patch: {
          tags: ['backends'],
          summary: 'Update a backend',
          parameters: [BACKEND_ID, EXPECTED_VERSION],
          requestBody: jsonBody({ type: 'object' }),
          responses: {
            200: okBody(ref('Backend')),
            ...errorResponses(['400', 'Invalid body'], ['404', 'Not found'], ['409', 'Version conflict']),
          },
        },
        delete: {
          tags: ['backends'],
          summary: 'Delete a backend',
          description: 'Tombstones the row and tears down any live connection. History keeps the reference.',
          parameters: [BACKEND_ID],
          responses: { 200: okBody(ref('Backend')), ...errorResponses(['404', 'Not found']) },
        },
      },
      '/api/v1/backends/{backendId}/runtime': {
        get: {
          tags: ['backends'],
          summary: 'One backend runtime state',
          parameters: [BACKEND_ID],
          responses: { 200: okBody(ref('RuntimeView')), ...errorResponses(['404', 'Not found']) },
        },
      },
      '/api/v1/backends/{backendId}/enable': {
        post: {
          tags: ['backends'],
          summary: 'Enable a backend',
          description: 'Makes it eligible. Does not dial.',
          parameters: [BACKEND_ID, EXPECTED_VERSION],
          responses: { 200: okBody(ref('Backend')), ...errorResponses(['404', 'Not found'], ['409', 'Version conflict']) },
        },
      },
      '/api/v1/backends/{backendId}/disable': {
        post: {
          tags: ['backends'],
          summary: 'Disable a backend',
          description: 'Stops any connection immediately and refuses new ones.',
          parameters: [BACKEND_ID, EXPECTED_VERSION],
          responses: { 200: okBody(ref('Backend')), ...errorResponses(['404', 'Not found'], ['409', 'Version conflict']) },
        },
      },
      '/api/v1/backends/{backendId}/connect': {
        post: {
          tags: ['backends'],
          summary: 'Connect a backend',
          parameters: [BACKEND_ID],
          responses: {
            200: okBody(ref('RuntimeView')),
            ...errorResponses(['404', 'Not found'], ['409', 'Disabled'], ['502', 'Connection failed'], ['504', 'Timed out']),
          },
        },
      },
      '/api/v1/backends/{backendId}/disconnect': {
        post: {
          tags: ['backends'],
          summary: 'Disconnect a backend',
          parameters: [BACKEND_ID],
          responses: { 200: okBody(ref('RuntimeView')), ...errorResponses(['404', 'Not found']) },
        },
      },
      '/api/v1/backends/{backendId}/reconnect': {
        post: {
          tags: ['backends'],
          summary: 'Reconnect a backend',
          parameters: [BACKEND_ID],
          responses: { 200: okBody(ref('RuntimeView')), ...errorResponses(['404', 'Not found']) },
        },
      },
      '/api/v1/backends/{backendId}/tools': {
        get: {
          tags: ['tools'],
          summary: "One backend's tools",
          parameters: [BACKEND_ID, ...queryParameters(z.object({ page: z.number().int().min(1), limit: z.number().int().min(1).max(100), search: z.string().optional() }))],
          responses: { 200: listBody(ref('Tool')), ...errorResponses(['400', 'Invalid query']) },
        },
      },
      '/api/v1/backends/{backendId}/tools/refresh': {
        post: {
          tags: ['tools'],
          summary: "Refresh one backend's catalog",
          parameters: [BACKEND_ID],
          responses: {
            200: okBody({ type: 'object' }),
            ...errorResponses(['404', 'Not found'], ['502', 'Discovery failed'], ['503', 'Backend unavailable']),
          },
        },
      },
      '/api/v1/tools': {
        get: {
          tags: ['tools'],
          summary: 'List discovered tools',
          description: 'Management visibility. A tool listed here is not necessarily callable by an agent — policy decides that.',
          parameters: queryParameters(
            z.object({
              page: z.number().int().min(1),
              limit: z.number().int().min(1).max(100),
              search: z.string().optional(),
              backendId: z.uuid().optional(),
              availability: z.enum(['available', 'unavailable', 'conflict']).optional(),
              sort: z.enum(['publicName', 'backendId', 'discoveredAt']).default('publicName'),
              order: z.enum(['asc', 'desc']).default('asc'),
            }),
          ),
          responses: { 200: listBody(ref('Tool')), ...errorResponses(['400', 'Invalid query']) },
        },
      },
      '/api/v1/tools/discovery': {
        get: {
          tags: ['tools'],
          summary: 'Last discovery report per backend',
          responses: { 200: okBody({ type: 'array', items: ref('DiscoveryReport') }) },
        },
      },
      '/api/v1/tools/conflicts': {
        get: {
          tags: ['tools'],
          summary: 'Public-name collisions',
          responses: { 200: okBody({ type: 'array', items: { type: 'object' } }) },
        },
      },
      '/api/v1/tools/refresh': {
        post: {
          tags: ['tools'],
          summary: 'Refresh every eligible catalog',
          description: 'Per-backend failures are reported in the body, not thrown.',
          responses: { 200: okBody({ type: 'object' }) },
        },
      },
      '/api/v1/tools/{publicName}': {
        get: {
          tags: ['tools'],
          summary: 'One tool by public name',
          parameters: [pathParam('publicName')],
          responses: { 200: okBody(ref('Tool')), ...errorResponses(['404', 'Not found']) },
        },
      },

      '/api/v1/agents': {
        get: {
          tags: ['agents'],
          summary: 'List agents',
          parameters: queryParameters(
            z.object({
              page: z.number().int().min(1),
              limit: z.number().int().min(1).max(100),
              search: z.string().optional(),
              enabled: z.enum(['true', 'false']).optional(),
              status: z.enum(['active', 'disabled']).optional(),
              clientType: z.string().optional(),
              sort: z.enum(['name', 'createdAt', 'updatedAt']).default('name'),
              order: z.enum(['asc', 'desc']).default('asc'),
            }),
          ),
          responses: { 200: listBody(ref('Agent')), ...errorResponses(['400', 'Invalid query']) },
        },
        post: {
          tags: ['agents'],
          summary: 'Create an agent',
          requestBody: jsonBody(AGENT_CREATE),
          responses: { 201: okBody(ref('Agent'), 'Created'), ...errorResponses(['400', 'Invalid body'], ['409', 'Name already exists']) },
        },
      },
      '/api/v1/agents/{agentId}': {
        get: {
          tags: ['agents'],
          summary: 'Get an agent',
          parameters: [AGENT_ID],
          responses: { 200: okBody(ref('Agent')), ...errorResponses(['404', 'Not found']) },
        },
        patch: {
          tags: ['agents'],
          summary: 'Update an agent',
          parameters: [AGENT_ID],
          requestBody: jsonBody({ type: 'object' }),
          responses: { 200: okBody(ref('Agent')), ...errorResponses(['400', 'Invalid body'], ['404', 'Not found'], ['409', 'Name conflict']) },
        },
        delete: {
          tags: ['agents'],
          summary: 'Delete an agent',
          description: 'Revokes credentials, removes policy assignments, and invalidates sessions in one transaction.',
          parameters: [AGENT_ID],
          responses: { 200: okBody({ type: 'object' }), ...errorResponses(['404', 'Not found']) },
        },
      },
      '/api/v1/agents/{agentId}/enable': {
        post: {
          tags: ['agents'],
          summary: 'Enable an agent',
          parameters: [AGENT_ID],
          responses: { 200: okBody(ref('Agent')), ...errorResponses(['404', 'Not found']) },
        },
      },
      '/api/v1/agents/{agentId}/disable': {
        post: {
          tags: ['agents'],
          summary: 'Disable an agent',
          description: 'Also invalidates its active sessions.',
          parameters: [AGENT_ID],
          responses: { 200: okBody(ref('Agent')), ...errorResponses(['404', 'Not found']) },
        },
      },
      '/api/v1/agents/{agentId}/access': {
        get: {
          tags: ['policies'],
          summary: 'Effective access for one agent',
          description: 'Evaluates the current catalog with the real authorization service. Read-only.',
          parameters: [AGENT_ID],
          responses: { 200: okBody({ type: 'object' }), ...errorResponses(['404', 'Not found']) },
        },
      },
      '/api/v1/agents/{agentId}/credentials': {
        get: {
          tags: ['agents'],
          summary: "List an agent's credentials",
          description: 'Never includes a token or a hash.',
          parameters: [AGENT_ID],
          responses: { 200: okBody({ type: 'array', items: ref('Credential') }), ...errorResponses(['404', 'Not found']) },
        },
        post: {
          tags: ['agents'],
          summary: 'Issue a credential',
          description: 'The only response in the product containing a raw token. It cannot be retrieved again.',
          parameters: [AGENT_ID],
          requestBody: jsonBody(CREDENTIAL_ISSUE),
          responses: { 201: okBody(ref('CredentialIssued'), 'Created'), ...errorResponses(['400', 'Invalid body'], ['404', 'Not found']) },
        },
      },
      '/api/v1/agents/{agentId}/credentials/{credentialId}/rotate': {
        post: {
          tags: ['agents'],
          summary: 'Rotate a credential',
          description: 'Revokes the old credential, issues a new one, and invalidates sessions bound to the old one.',
          parameters: [AGENT_ID, pathParam('credentialId', 'uuid')],
          requestBody: jsonBody(CREDENTIAL_ISSUE),
          responses: { 200: okBody(ref('CredentialIssued')), ...errorResponses(['400', 'Invalid body'], ['404', 'Not found']) },
        },
      },
      '/api/v1/agents/{agentId}/credentials/{credentialId}/revoke': {
        post: {
          tags: ['agents'],
          summary: 'Revoke a credential',
          description: 'Idempotent. Invalidates the sessions it authenticated.',
          parameters: [AGENT_ID, pathParam('credentialId', 'uuid')],
          responses: { 200: okBody(ref('Credential')), ...errorResponses(['404', 'Not found']) },
        },
      },

      '/api/v1/policies': {
        get: {
          tags: ['policies'],
          summary: 'List policies',
          parameters: queryParameters(
            z.object({
              page: z.number().int().min(1),
              limit: z.number().int().min(1).max(100),
              search: z.string().optional(),
              effect: z.enum(['allow', 'deny']).optional(),
              agentId: z.uuid().optional(),
              backendId: z.uuid().optional(),
              sort: z.enum(['name', 'createdAt', 'updatedAt', 'priority']).default('name'),
              order: z.enum(['asc', 'desc']).default('asc'),
            }),
          ),
          responses: { 200: listBody(ref('Policy')), ...errorResponses(['400', 'Invalid query']) },
        },
        post: {
          tags: ['policies'],
          summary: 'Create a policy',
          requestBody: jsonBody(POLICY_CREATE),
          responses: { 201: okBody(ref('Policy'), 'Created'), ...errorResponses(['400', 'Invalid body'], ['409', 'Name already exists']) },
        },
      },
      '/api/v1/policies/{policyId}': {
        get: {
          tags: ['policies'],
          summary: 'Get a policy',
          parameters: [POLICY_ID],
          responses: { 200: okBody(ref('Policy')), ...errorResponses(['404', 'Not found']) },
        },
        patch: {
          tags: ['policies'],
          summary: 'Update a policy',
          parameters: [POLICY_ID],
          requestBody: jsonBody({ type: 'object' }),
          responses: { 200: okBody(ref('Policy')), ...errorResponses(['400', 'Invalid body'], ['404', 'Not found'], ['409', 'Name conflict']) },
        },
        delete: {
          tags: ['policies'],
          summary: 'Delete a policy',
          parameters: [POLICY_ID],
          responses: { 200: okBody(ref('Policy')), ...errorResponses(['404', 'Not found']) },
        },
      },
      '/api/v1/policies/{policyId}/assignments': {
        post: {
          tags: ['policies'],
          summary: 'Assign a policy to an agent',
          parameters: [POLICY_ID],
          requestBody: jsonBody({ type: 'object', required: ['agentId'], properties: { agentId: { type: 'string', format: 'uuid' } }, additionalProperties: false }),
          responses: { 200: okBody(ref('Policy')), ...errorResponses(['400', 'Invalid body'], ['404', 'Not found']) },
        },
      },
      '/api/v1/policies/{policyId}/assignments/{agentId}': {
        delete: {
          tags: ['policies'],
          summary: 'Unassign a policy from an agent',
          parameters: [POLICY_ID, AGENT_ID],
          responses: { 200: okBody(ref('Policy')), ...errorResponses(['404', 'Not found']) },
        },
      },

      '/api/v1/sessions': {
        get: {
          tags: ['sessions'],
          summary: 'List sessions',
          description:
            '`status` filters on the effective status, so `expired` includes sessions whose lifetime lapsed but which the sweep has not written back.',
          parameters: queryParameters(listSessionsQuerySchema),
          responses: { 200: listBody(ref('Session')), ...errorResponses(['400', 'Invalid query']) },
        },
      },
      '/api/v1/sessions/cleanup': {
        post: {
          tags: ['sessions'],
          summary: 'Expire lapsed sessions',
          description: 'Safe to run concurrently; rows are retained with a status and a reason.',
          responses: { 200: okBody({ type: 'object' }) },
        },
      },
      '/api/v1/sessions/{sessionId}': {
        get: {
          tags: ['sessions'],
          summary: 'Get a session',
          parameters: [SESSION_ID],
          responses: { 200: okBody(ref('Session')), ...errorResponses(['404', 'Not found']) },
        },
      },
      '/api/v1/sessions/{sessionId}/terminate': {
        post: {
          tags: ['sessions'],
          summary: 'Terminate a session',
          description: 'Idempotent, and never reactivates a finished session. A body is optional.',
          parameters: [SESSION_ID],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { reason: { type: 'string', enum: ['operator_terminated', 'client_deleted', 'cleanup'] } },
                  additionalProperties: false,
                },
              },
            },
          },
          responses: { 200: okBody(ref('Session')), ...errorResponses(['400', 'Invalid body'], ['404', 'Not found']) },
        },
      },

      '/api/v1/activity': {
        get: {
          tags: ['activity'],
          summary: 'List activity',
          parameters: queryParameters(listActivityQuerySchema),
          responses: { 200: listBody(ref('ActivityEvent')), ...errorResponses(['400', 'Invalid query']) },
        },
      },
      '/api/v1/activity/{eventId}': {
        get: {
          tags: ['activity'],
          summary: 'Get an activity event',
          parameters: [EVENT_ID],
          responses: { 200: okBody(ref('ActivityEvent')), ...errorResponses(['404', 'Not found']) },
        },
      },
      '/api/v1/audit': {
        get: {
          tags: ['audit'],
          summary: 'List audit events',
          description: 'Metadata is omitted from the list; read one event to see it. Audit rows have no write path.',
          parameters: queryParameters(listAuditQuerySchema),
          responses: { 200: listBody(ref('AuditEvent')), ...errorResponses(['400', 'Invalid query']) },
        },
      },
      '/api/v1/audit/{eventId}': {
        get: {
          tags: ['audit'],
          summary: 'Get an audit event',
          parameters: [EVENT_ID],
          responses: { 200: okBody(ref('AuditEvent')), ...errorResponses(['404', 'Not found']) },
        },
      },

      '/api/v1/monitoring': {
        get: {
          tags: ['monitoring'],
          summary: 'Operational summary',
          responses: { 200: okBody({ type: 'object' }) },
        },
      },
      '/api/v1/monitoring/health': {
        get: {
          tags: ['monitoring'],
          summary: 'Storage and backend health summary',
          responses: { 200: okBody({ type: 'object' }) },
        },
      },
      '/api/v1/monitoring/backends': {
        get: {
          tags: ['monitoring'],
          summary: 'Backend distribution and discovery state',
          responses: { 200: okBody({ type: 'object' }) },
        },
      },
      '/api/v1/monitoring/sessions': {
        get: {
          tags: ['monitoring'],
          summary: 'Session state distribution',
          description: 'Reports `available: false` when session tracking is not wired, rather than a fabricated zero.',
          responses: { 200: okBody({ type: 'object' }) },
        },
      },
      '/api/v1/monitoring/runtime': {
        get: {
          tags: ['monitoring'],
          summary: 'Process runtime facts',
          responses: { 200: okBody({ type: 'object' }) },
        },
      },

      '/mcp': {
        post: {
          tags: ['system'],
          summary: 'MCP protocol endpoint',
          description:
            'Streamable HTTP MCP surface. Authenticated per request with an agent bearer token; tool access is then decided by policy (default deny). Not part of the REST envelope contract.',
          security: [{ agentBearer: [] }],
          responses: {
            200: { description: 'JSON-RPC response (or an SSE stream)' },
            401: { description: 'Missing or invalid credential' },
          },
        },
      },
    },
    'x-gateway': { apiPrefix: '/api/v1', environment: config.environment, loopbackOnly: true },
  };
}
