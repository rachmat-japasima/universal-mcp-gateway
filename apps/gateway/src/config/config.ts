import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/**
 * Gateway configuration.
 *
 * Precedence (highest first): explicit overrides → environment variables →
 * defaults. No YAML file is read: nothing in Phase 2 needs values that env vars
 * cannot express, and a second source would only add a precedence rule to
 * document and test. Add it when a setting genuinely needs a nested shape.
 */

/** Loopback-only by design; non-loopback exposure needs explicit approval and a security review. */
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;

/** Endpoints are fixed in this phase; changing them would break existing clients. */
export const MCP_ENDPOINT = '/mcp';
export const HEALTH_ENDPOINT = '/health';

export const ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

const DEFAULT_DATABASE_PATH = './data/gateway.db';

/**
 * The repository root this package lives in, anchored to this file so the
 * process working directory cannot change it. `src/config/config.ts` and its
 * build output `dist/config/config.js` sit at the same depth under
 * `apps/gateway` (two levels), so four hops up are the repository root in
 * development and production alike. Relative `DATABASE_PATH` values — the
 * default included — resolve against it: the gateway may be started from the
 * repository root, from `apps/gateway`, or by a supervisor with its own
 * working directory, and all three must mean the same `<repo>/data/gateway.db`,
 * never a second database silently created wherever the process happened to
 * start.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export const configSchema = z
  .object({
    environment: z.enum(ENVIRONMENTS).default('development'),
    host: z
      .string()
      .default('127.0.0.1')
      .refine((host) => (LOOPBACK_HOSTS as readonly string[]).includes(host), {
        message: `host must be a loopback address (${LOOPBACK_HOSTS.join(', ')})`,
      }),
    port: z.coerce.number().int().min(1).max(65535).default(8787),
    mcpEndpoint: z.literal(MCP_ENDPOINT).default(MCP_ENDPOINT),
    healthEndpoint: z.literal(HEALTH_ENDPOINT).default(HEALTH_ENDPOINT),
    databasePath: z
      .string()
      .trim()
      .min(1)
      .default(DEFAULT_DATABASE_PATH)
      .refine((path) => !path.includes('\0'), { message: 'databasePath must not contain null bytes' }),
    logLevel: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Upper bound for a single MCP request body, in bytes. */
    requestBodyLimitBytes: z.coerce.number().int().min(1024).max(64 * 1024 * 1024).default(4 * 1024 * 1024),
    /** Upper bound for one inbound MCP request exchange. */
    requestTimeoutMs: z.coerce.number().int().min(100).max(600_000).default(30_000),
    /** Used once session tracking exists (Phase 7). */
    sessionIdleTimeoutMs: z.coerce.number().int().min(60_000).max(86_400_000).default(1_800_000),
    sessionMaxLifetimeMs: z.coerce.number().int().min(60_000).max(604_800_000).default(43_200_000),
    /**
     * Automatic reconnect after an unexpected disconnect or a transient failure.
     * Off by default: an operator who has just lost a backend should not find it
     * being dialled again behind their back on first start.
     */
    reconnectEnabled: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    reconnectInitialDelayMs: z.coerce.number().int().min(100).max(600_000).default(1_000),
    reconnectMaxDelayMs: z.coerce.number().int().min(100).max(3_600_000).default(60_000),
    reconnectMaxAttempts: z.coerce.number().int().min(1).max(100).default(5),
    /** ± fraction of each delay, so simultaneous failures do not retry in lockstep. */
    reconnectJitterRatio: z.coerce.number().min(0).max(1).default(0.2),
    /**
     * Opt-in for loopback/private Streamable HTTP destinations. Only for local
     * fixtures; enabling it widens the SSRF surface documented in SECURITY.md.
     */
    allowPrivateNetwork: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    /**
     * Bound on one `tools/list` during discovery. Separate from a backend's own
     * `timeoutMs` so a slow catalog cannot make a healthy backend look dead, and
     * so discovery can be tightened without touching per-call behaviour.
     */
    toolDiscoveryTimeoutMs: z.coerce.number().int().min(100).max(120_000).default(15_000),
    /**
     * Outer bound on one routed tool call. The backend's own `timeoutMs` applies
     * inside the client; this stops a misconfigured backend from pinning an
     * inbound request open.
     */
    toolCallTimeoutMs: z.coerce.number().int().min(100).max(600_000).default(60_000),
    /**
     * Operator (dashboard) sessions are separate from MCP sessions: a human
     * sitting at a dashboard and a tool call have different natural lifetimes,
     * and coupling them would mean tightening one tightens the other.
     */
    operatorSessionIdleTimeoutMs: z.coerce.number().int().min(60_000).max(86_400_000).default(1_800_000),
    operatorSessionMaxLifetimeMs: z.coerce.number().int().min(60_000).max(604_800_000).default(43_200_000),
    /**
     * `Secure` would make the cookie unreachable over the plain-HTTP loopback
     * dashboard this product ships, producing a login that silently never works.
     * It is therefore explicit and off by default, never inferred from a
     * forwarded header: turn it on only when the dashboard is served over TLS.
     */
    operatorCookieSecure: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;

/** The exact subset of `process.env` this module reads. */
export interface ConfigEnv {
  ENVIRONMENT?: string;
  HOST?: string;
  PORT?: string;
  DATABASE_PATH?: string;
  LOG_LEVEL?: string;
  REQUEST_BODY_LIMIT_BYTES?: string;
  REQUEST_TIMEOUT_MS?: string;
  SESSION_IDLE_TIMEOUT_MS?: string;
  SESSION_MAX_LIFETIME_MS?: string;
  RECONNECT_ENABLED?: string;
  RECONNECT_INITIAL_DELAY_MS?: string;
  RECONNECT_MAX_DELAY_MS?: string;
  RECONNECT_MAX_ATTEMPTS?: string;
  RECONNECT_JITTER_RATIO?: string;
  ALLOW_PRIVATE_NETWORK?: string;
  TOOL_DISCOVERY_TIMEOUT_MS?: string;
  TOOL_CALL_TIMEOUT_MS?: string;
  OPERATOR_SESSION_IDLE_TIMEOUT_MS?: string;
  OPERATOR_SESSION_MAX_LIFETIME_MS?: string;
  OPERATOR_COOKIE_SECURE?: string;
}

function envValue(env: ConfigEnv, key: keyof ConfigEnv): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

/** Pure parse: never throws, never exits, never logs. Safe to unit test. */
export function parseConfig(
  env: ConfigEnv,
  overrides: Partial<Config> = {},
): { ok: true; config: Config } | { ok: false; issues: z.core.$ZodIssue[] } {
  const candidate = {
    environment: envValue(env, 'ENVIRONMENT'),
    host: envValue(env, 'HOST'),
    port: envValue(env, 'PORT'),
    databasePath: envValue(env, 'DATABASE_PATH'),
    logLevel: envValue(env, 'LOG_LEVEL'),
    requestBodyLimitBytes: envValue(env, 'REQUEST_BODY_LIMIT_BYTES'),
    requestTimeoutMs: envValue(env, 'REQUEST_TIMEOUT_MS'),
    sessionIdleTimeoutMs: envValue(env, 'SESSION_IDLE_TIMEOUT_MS'),
    sessionMaxLifetimeMs: envValue(env, 'SESSION_MAX_LIFETIME_MS'),
    reconnectEnabled: envValue(env, 'RECONNECT_ENABLED'),
    reconnectInitialDelayMs: envValue(env, 'RECONNECT_INITIAL_DELAY_MS'),
    reconnectMaxDelayMs: envValue(env, 'RECONNECT_MAX_DELAY_MS'),
    reconnectMaxAttempts: envValue(env, 'RECONNECT_MAX_ATTEMPTS'),
    reconnectJitterRatio: envValue(env, 'RECONNECT_JITTER_RATIO'),
    allowPrivateNetwork: envValue(env, 'ALLOW_PRIVATE_NETWORK'),
    toolDiscoveryTimeoutMs: envValue(env, 'TOOL_DISCOVERY_TIMEOUT_MS'),
    toolCallTimeoutMs: envValue(env, 'TOOL_CALL_TIMEOUT_MS'),
    operatorSessionIdleTimeoutMs: envValue(env, 'OPERATOR_SESSION_IDLE_TIMEOUT_MS'),
    operatorSessionMaxLifetimeMs: envValue(env, 'OPERATOR_SESSION_MAX_LIFETIME_MS'),
    operatorCookieSecure: envValue(env, 'OPERATOR_COOKIE_SECURE'),
    ...overrides,
  };

  const result = configSchema.safeParse(candidate);
  return result.success
    ? { ok: true, config: { ...result.data, databasePath: resolve(REPO_ROOT, result.data.databasePath) } }
    : { ok: false, issues: result.error.issues };
}

/**
 * Loads configuration for a process. Invalid configuration is fatal, but the
 * error is an `AppError` so the caller decides how to report it — this module
 * does not exit the process.
 */
export function loadConfig(env: ConfigEnv = process.env, overrides: Partial<Config> = {}): Config {
  const result = parseConfig(env, overrides);

  if (!result.ok) {
    const detail = result.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new ConfigError(`Invalid gateway configuration: ${detail}`);
  }

  return result.config;
}

/** Thrown for invalid configuration. Declared here to keep `shared/errors` config-free. */
export class ConfigError extends Error {
  readonly code = 'CONFIGURATION_ERROR' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

/** Configuration safe to log: paths and limits are fine, nothing secret exists here yet. */
export function redactConfig(config: Config): Record<string, unknown> {
  return { ...config };
}
