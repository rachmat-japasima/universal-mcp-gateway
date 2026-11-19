import type { Readiness } from '@/lib/api/types';

/**
 * Runtime validation for `/ready`, which is the one endpoint the dashboard reads
 * *raw* — it has no `{data}` envelope and answers `503` with a real body.
 *
 * That combination is exactly why a shape check is required rather than a cast.
 * `fetch` resolves for `503`, and the app's own proxy answers an unreachable
 * gateway with a `503` **error envelope**; casting that to `Readiness` would make
 * the header report "Gateway not ready" for a gateway that is not there at all.
 * The two states look similar but are different claims, so they stay different.
 *
 * Required fields mirror the readiness contract in
 * `src/api/routes/ops.routes.ts` (`readyHandler`): `status`, both `checks`
 * members, and `timestamp`. `migrationVersion` is optional there — it is omitted
 * exactly when migrations are unreadable — so validating it as required would
 * reject a legitimate `not_ready` answer.
 */

const READY_STATUSES = ['ready', 'not_ready'] as const;
const CHECK_STATES = ['ok', 'unavailable'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

export function isReadiness(value: unknown): value is Readiness {
  if (!isRecord(value)) return false;
  if (!isOneOf(value.status, READY_STATUSES)) return false;
  if (typeof value.timestamp !== 'string') return false;

  const { checks } = value;
  if (!isRecord(checks)) return false;
  if (!isOneOf(checks.database, CHECK_STATES)) return false;
  if (!isOneOf(checks.migrations, CHECK_STATES)) return false;

  // Optional, but if present it must be the documented type — a wrong-typed
  // field is a contract mismatch, not something to tolerate.
  if ('migrationVersion' in value && typeof value.migrationVersion !== 'string') return false;

  return true;
}
