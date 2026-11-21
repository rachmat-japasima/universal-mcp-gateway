import { z } from 'zod';

import { idSchema, timestampSchema } from '../domain/primitives.js';
import { providerIdSchema, providerMetadataSchema } from './provider.js';

/**
 * A user-facing instance of a provider (ADR-051).
 *
 * One provider, many connections — two GitHub orgs are two rows. The model
 * deliberately echoes `backend.ts`: persistent configuration only, no live
 * handle here. A connection's credentials live in the vault under
 * `credentialId`; this row stores the *reference*, never the value.
 *
 * Statuses mirror `backend-runtime.ts` style: legal edges are declared as
 * data so the lifecycle cannot invent a transition and a test can enumerate
 * every pair.
 */

/**
 * Connection lifecycle. Semantics:
 *
 *  * `pending`           — created, never connected (credentials may not be
 *    verified yet).
 *  * `connecting`        — a connect attempt is in flight.
 *  * `connected`         — usable: tools may be discovered and executed.
 *  * `disconnected`      — at rest. The row survives; tools do not.
 *  * `error`             — last attempt failed for a non-auth reason.
 *  * `reauthorization_required` — the provider rejected the stored
 *    credential. Exits only through an explicit operator connect after
 *    re-storing one, or `disabled`; execution fails closed in this state,
 *    which is why it is not folded into `error`.
 *  * `disabled`          — operator turned it off. Terminal: the only status
 *    with no outgoing edge.
 */
export const CONNECTION_STATUSES = [
  'pending',
  'connecting',
  'connected',
  'disconnected',
  'error',
  'reauthorization_required',
  'disabled',
] as const;
export const connectionStatusSchema = z.enum(CONNECTION_STATUSES);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

/**
 * Legal lifecycle edges. Same declaration style as `backend-runtime.ts`.
 *
 * Notable choices:
 *  * Every non-terminal status has a `→ disabled` edge: an operator can always
 *    turn a connection off, whatever state it is in.
 *  * `disabled` exits only through `connecting` — the explicit operator
 *    re-enable added in Phase 13 (ADR-053), never an automatic path. Before
 *    Phase 13 it was fully terminal; "turn it back on" is the same explicit
 *    action `connect` already is for every other status.
 *  * `error` and `reauthorization_required` exit only through `connecting` —
 *    the same explicit operator action (`connect`, after re-storing a
 *    credential), never an automatic one. The router never triggers either.
 *  * `connecting` may land in `reauthorization_required`: the verification
 *    handshake refused the credential (Phase 13). The fix is a new token, not
 *    a retry, so the row says exactly that instead of "error".
 */
export const CONNECTION_TRANSITIONS: ReadonlyArray<readonly [ConnectionStatus, ConnectionStatus]> = [
  ['pending', 'connecting'],
  ['pending', 'disabled'],
  ['connecting', 'connected'],
  ['connecting', 'error'],
  ['connecting', 'reauthorization_required'],
  ['connecting', 'disconnected'],
  ['connecting', 'disabled'],
  ['connected', 'disconnected'],
  ['connected', 'error'],
  ['connected', 'reauthorization_required'],
  ['connected', 'disabled'],
  ['disconnected', 'connecting'],
  ['disconnected', 'disabled'],
  ['error', 'connecting'],
  ['error', 'disabled'],
  ['reauthorization_required', 'connecting'],
  ['reauthorization_required', 'disabled'],
  ['disabled', 'connecting'],
];

/** Deterministic: `(from, to) => legal`. Pure so tests enumerate every pair. */
export function canTransition(from: ConnectionStatus, to: ConnectionStatus): boolean {
  return CONNECTION_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** Statuses from which tools may be discovered and executed. */
export const CALLABLE_CONNECTION_STATUSES: readonly ConnectionStatus[] = ['connected'];

/**
 * Non-secret connection settings (org name, workspace, options). The rule is
 * the same as backend `config_json`: validated, non-secret payloads only.
 * Credentials go to the vault at creation; nothing here is ever a value.
 */
export const connectionMetadataSchema = providerMetadataSchema;

export const integrationConnectionSchema = z.object({
  id: idSchema,
  /** Registry key of the provider this connection instantiates. */
  providerId: providerIdSchema,
  /** Operator-facing label. */
  name: z.string().trim().min(1).max(100),
  status: connectionStatusSchema,
  /**
   * Vault reference for the stored credential, or `null` when the connection
   * has none yet. A reference, never a value (ADR-052).
   */
  credentialId: idSchema.nullable(),
  /** Non-secret settings. */
  metadata: connectionMetadataSchema.default({}),
  /**
   * When the connection last proved its credential against the provider
   * (migration 0009, Phase 13). `null` until the first successful validation:
   * a `pending` or `error` row has never validated anything.
   */
  validatedAt: timestampSchema.nullable().default(null),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>;

export const createConnectionSchema = z.object({
  id: idSchema,
  providerId: providerIdSchema,
  name: z.string().trim().min(1).max(100),
  metadata: connectionMetadataSchema.default({}),
});
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;

/**
 * One stored integration credential (ADR-051).
 *
 * The only persistent form a credential ever takes: a vault envelope string,
 * never the value. `connectionId` is the cleanup back-reference; deleting a
 * connection row removes its credential rows with it (migration 0008).
 */
export const storedIntegrationCredentialSchema = z
  .object({
    id: idSchema,
    connectionId: idSchema.nullable(),
    /** Sealed envelope from `EnvelopeVault.seal`. No plaintext column exists anywhere. */
    envelope: z.string().min(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type StoredIntegrationCredential = z.infer<typeof storedIntegrationCredentialSchema>;
