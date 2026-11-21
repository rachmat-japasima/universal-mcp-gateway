import type { MonitoringHealth, Readiness } from '@/lib/api/types';
import type { StatusLabel } from '@/lib/utils/status';

/**
 * The three separate questions a monitoring page has to keep apart.
 *
 * They are not interchangeable, and collapsing them into one green dot is the
 * specific mistake this page exists to prevent:
 *
 *  * **liveness** — `/health`. Is the process serving at all? It answers without
 *    consulting storage, by design, so it can be `ok` while readiness fails.
 *  * **readiness** — `/ready`. Can it serve? Storage answers and the migration
 *    ledger is readable. A `503` here is a real answer, not a transport failure.
 *  * **dependency health** — `/monitoring/health`. The management view of the
 *    same storage plus the backend registry, which readiness deliberately
 *    ignores: a gateway with every backend disconnected is still ready to work.
 *
 * Each function returns words as well as a tone, because colour never carries
 * the meaning on its own.
 */

export function livenessStatus(ok: boolean): StatusLabel {
  return ok ? { label: 'Process alive', tone: 'success' } : { label: 'No answer from /health', tone: 'error' };
}

export function readinessStatus(readiness: Readiness): StatusLabel {
  return readiness.status === 'ready'
    ? { label: 'Ready', tone: 'success' }
    : { label: 'Not ready', tone: 'error' };
}

export function dependencyStatus(health: MonitoringHealth): StatusLabel {
  if (health.database === 'unavailable') return { label: 'Degraded — storage unavailable', tone: 'error' };
  if (health.status === 'degraded') return { label: 'Degraded', tone: 'warning' };
  return { label: 'Healthy', tone: 'success' };
}

/**
 * Explains what a readiness `503` means in words. `fetch` does not throw on a
 * non-2xx here, so the body — already validated as a readiness document — is what
 * decides the message rather than the status code.
 */
export function readinessDetail(readiness: Readiness): string {
  const { database, migrations } = readiness.checks;
  const schema = readiness.migrationVersion === undefined ? '' : ` · schema ${readiness.migrationVersion}`;

  return `database ${database} · migrations ${migrations}${schema}`;
}
