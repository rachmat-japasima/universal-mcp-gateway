import { z } from 'zod';

import { timestampSchema } from '../domain/primitives.js';

/**
 * A managed-integration provider definition (ADR-050).
 *
 * Code-registered only: no dynamic loading, no marketplace, no plugin
 * directory. A provider exists because a developer wrote it into the
 * registry list, which means every entry is reviewed, typed, and covered by
 * the connector contract — and the production registry started empty exactly
 * like the backend registry did (ADR-002). Phase 13 registers the first real
 * provider, GitHub (ADR-053).
 *
 * A *provider* is a connector implementation ("GitHub"), a *connection* is a
 * user-facing instance of one ("my GitHub org"). They are separate tables of
 * state for the same reason backend config and runtime are separate.
 */

/**
 * Provider registry key. A developer-chosen slug, deliberately NOT the row-id
 * `idSchema`: it appears in operator-facing views and connection rows, and
 * `github` is both more honest and more stable than a generated UUID. Stable
 * once published — connections reference it by this string.
 */
export const providerIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'Provider ids are lowercase slugs: "github", not a UUID.');

/** Connector capabilities a provider must declare up front. */
export const PROVIDER_CAPABILITIES = ['discovery', 'execution'] as const;
export const providerCapabilitySchema = z.enum(PROVIDER_CAPABILITIES);
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

/**
 * Non-secret provider metadata shown to operators. The shape is open on
 * purpose: providers differ (a repo host needs an org name, a chat tool a
 * workspace); what is *closed* is the rule that no credential ever appears
 * here — validation happens at the connection boundary, values live in the
 * vault.
 */
export const providerMetadataSchema = z.record(z.string(), z.unknown());

export const providerDefinitionSchema = z.object({
  /** Registry key. Stable once published: connections reference it. */
  id: providerIdSchema,
  /** Operator-facing name. */
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  /** What the connector can do. Discovery without execution is list-only. */
  capabilities: z.array(providerCapabilitySchema).min(1),
  /**
   * Public metadata describing the provider (docs URL, tool catalogue shape).
   * Validated as JSON, never trusted with secrets, never executed.
   */
  metadata: providerMetadataSchema.default({}),
  /** When the developer registered the provider (build time, not persisted). */
  registeredAt: timestampSchema,
});
export type ProviderDefinition = z.infer<typeof providerDefinitionSchema>;

/** Create-time input: `registeredAt` is stamped by the registry, not the caller. */
export const providerRegistrationSchema = providerDefinitionSchema.omit({ registeredAt: true });
export type ProviderRegistration = z.infer<typeof providerRegistrationSchema>;
