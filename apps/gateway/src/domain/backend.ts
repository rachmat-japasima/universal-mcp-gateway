import { z } from 'zod';

import { idSchema, secretRefSchema, timestampSchema } from './primitives.js';

/**
 * MCP backend definition.
 *
 * Persistent configuration only. Live processes, MCP clients, and transport
 * handles never belong here — they live in runtime state (see `backend-runtime.ts`).
 */

export const TRANSPORT_TYPES = ['stdio', 'streamable-http'] as const;
export const transportTypeSchema = z.enum(TRANSPORT_TYPES);
export type TransportType = z.infer<typeof transportTypeSchema>;

export const CONCURRENCY_MODES = ['parallel', 'serialized', 'limited'] as const;
export const concurrencyModeSchema = z.enum(CONCURRENCY_MODES);
export type ConcurrencyMode = z.infer<typeof concurrencyModeSchema>;

/**
 * POSIX env-var name. Stricter than a bare string on purpose: this is what a
 * child process can actually receive, and a pasted secret would otherwise pass
 * as a name, be stored in `config_json`, and be echoed by every read.
 */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** RFC 7230 token, the only legal shape for an HTTP header name. */
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

/**
 * Executable + argument array. Shell strings are deliberately unrepresentable so
 * a config can never smuggle interpolation into a child process.
 *
 * `command` is one executable token: arguments, flags, quoting, and pipes all
 * belong in `args`. A shell-looking string is rejected rather than silently
 * split, so `node server.js` fails loudly at validation instead of becoming a
 * command that is not found at connect time (or, worse, being run by a shell).
 */
const SHELL_SYNTAX = /[\s;&|<>`$()]/;

export const stdioConnectionSchema = z
  .object({
    command: z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .refine((command) => !SHELL_SYNTAX.test(command), {
        message: 'command must be a single executable; put arguments in args',
      }),
    args: z.array(z.string().max(4096)).max(64).default([]),
    /** Working directory; relative paths resolve against the gateway cwd. */
    cwd: z.string().trim().min(1).max(1024).optional(),
    /** Environment entries may only be secret references, never literal secrets. */
    env: z.record(
      z.string().regex(ENV_NAME_PATTERN, {
        message: 'env keys must be POSIX variable names ([A-Za-z_][A-Za-z0-9_]*)',
      }),
      secretRefSchema,
    ).default({}),
  })
  .strict();

export const streamableHttpConnectionSchema = z
  .object({
    url: z.url({ protocol: /^https?$/ }),
    headers: z.record(
      z.string().regex(HEADER_NAME_PATTERN, { message: 'headers keys must be HTTP header names' }),
      secretRefSchema,
    ).default({}),
  })
  .strict();

/** Discriminated so a transport type can never carry another transport's config. */
export const backendConnectionSchema = z.discriminatedUnion('type', [
  stdioConnectionSchema.extend({ type: z.literal('stdio') }),
  streamableHttpConnectionSchema.extend({ type: z.literal('streamable-http') }),
]);
export type BackendConnection = z.infer<typeof backendConnectionSchema>;

const backendFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  connection: backendConnectionSchema,
  enabled: z.boolean().default(true),
  /** Per-call timeout applied by the adapter. */
  timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
  concurrencyMode: concurrencyModeSchema.default('serialized'),
  /** Only meaningful when `concurrencyMode` is `limited`. */
  concurrencyLimit: z.number().int().min(1).max(64).optional(),
};

/** Cross-field rule: a limit exists if and only if the mode is `limited`. */
const refineConcurrency: (value: {
  concurrencyMode: ConcurrencyMode;
  concurrencyLimit?: number | undefined;
}) => boolean = (value) =>
  value.concurrencyMode === 'limited'
    ? value.concurrencyLimit !== undefined
    : value.concurrencyLimit === undefined;

const concurrencyIssue = {
  message: 'concurrencyLimit is required when concurrencyMode is "limited", and only then',
  path: ['concurrencyLimit'],
};

export const createBackendSchema = z.object(backendFields).strict().refine(refineConcurrency, concurrencyIssue);

/**
 * Delete operations use a tombstone so audit history keeps a valid reference.
 *
 * No defaults here: a default in an update schema would overwrite a stored value
 * the caller never mentioned. `null` clears a nullable field; `undefined` keeps it.
 */
export const updateBackendSchema = z
  .object({
    name: backendFields.name.optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    connection: backendConnectionSchema.optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).max(600_000).optional(),
    concurrencyMode: concurrencyModeSchema.optional(),
    concurrencyLimit: z.number().int().min(1).max(64).nullable().optional(),
  })
  .strict()
  /** Only reject a pair the caller actually specified; the repo merges the rest. */
  .refine((value) => {
    if (!('concurrencyMode' in value) || !('concurrencyLimit' in value)) return true;
    const limit = value.concurrencyLimit ?? undefined;
    return value.concurrencyMode === 'limited' ? limit !== undefined : limit === undefined;
  }, concurrencyIssue);

export const backendSchema = z
  .object({
    id: idSchema,
    ...backendFields,
    /**
     * Optimistic-concurrency counter. Incremented on every persisted change;
     * callers pass it back on update to prove they edited a current copy.
     */
    version: z.number().int().min(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine(refineConcurrency, concurrencyIssue);

/**
 * `z.input` for create payloads: fields with defaults may be omitted by the
 * caller, and the repository's `parse()` fills them in. `z.infer` (output) is
 * only for values read back out of storage.
 */
export type CreateBackendInput = z.input<typeof createBackendSchema>;
export type UpdateBackendInput = z.infer<typeof updateBackendSchema>;
export type Backend = z.infer<typeof backendSchema>;
