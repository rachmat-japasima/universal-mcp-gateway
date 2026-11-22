import { z } from 'zod';

/** UTC ISO-8601 instant, e.g. `2026-11-18T02:38:03.398Z`. */
export const timestampSchema = z.iso.datetime();

export const idSchema = z.uuid();

/**
 * Secret *reference*, never a secret value. Resolved by the secret store in a
 * later phase.
 *
 * The scheme prefix is required because no pattern can tell `sk-live-abc123`
 * (a secret) apart from `api-key` (a name). Requiring `secret:`/`env:` makes the
 * intent explicit, so a literal that was pasted into a config is rejected
 * instead of being persisted in `config_json`.
 */
export const secretRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^(?:secret|env):[A-Za-z0-9._:/-]+$/,
    'Secret references must be "secret:<path>" or "env:<VAR>", never a literal value',
  );

export type Timestamp = z.infer<typeof timestampSchema>;
export type Id = z.infer<typeof idSchema>;
