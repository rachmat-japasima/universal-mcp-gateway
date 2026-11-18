import type { BackendLifecycleManager } from '../adapters/lifecycle.js';
import type { BackendStatus } from '../domain/backend-runtime.js';
import { BACKEND_STATUSES } from '../domain/backend-runtime.js';
import type { SessionStatus } from '../domain/session.js';
import type { Database } from '../infrastructure/database/index.js';
import type { SessionService } from '../registry/session-service.js';
import type { ToolCatalog } from '../routing/catalog.js';

/**
 * One read of the gateway's operational facts, used by `/overview`,
 * `/monitoring*` and `/diagnostics`.
 *
 * Why one module: three endpoints reporting different backend counts from
 * three code paths is the classic dashboard bug. Every consumer asks this
 * function, so the numbers cannot disagree.
 *
 * Every value is read from a repository, the lifecycle manager, or the in-memory
 * catalog. Nothing here is estimated, sampled, or defaulted to a plausible
 * number: an empty registry yields zeros, and an unavailable database yields
 * `null` rather than zero (the two are different claims).
 */

export interface BackendCounts {
  total: number;
  enabled: number;
  disabled: number;
  /** Distribution of `RuntimeView.status` over every registered backend. */
  runtime: Record<BackendStatus, number>;
}

export interface ToolCounts {
  /** Every tool the catalog knows, including withheld ones. */
  total: number;
  available: number;
  unavailable: number;
  conflict: number;
  /** Backends holding a catalog snapshot (i.e. discovery has run). */
  backendsWithCatalog: number;
  discoveryFailures: number;
}

export interface AgentCounts {
  total: number;
  enabled: number;
  disabled: number;
}

export type SessionCounts = Record<SessionStatus, number>;

export interface ActivityCounts {
  total: number;
  byType: Record<string, number>;
  byOutcome: Record<string, number>;
}

export interface OpsSnapshot {
  /** `unavailable` means the read failed; every storage-backed field is `null`. */
  database: 'ok' | 'unavailable';
  backends: BackendCounts | null;
  tools: ToolCounts | null;
  agents: AgentCounts | null;
  /** `null` when no session service is wired, `null` counts when the read failed. */
  sessions: SessionCounts | null;
  activity: ActivityCounts | null;
}

export interface OpsDependencies {
  store: Database;
  lifecycle: BackendLifecycleManager;
  catalog: ToolCatalog;
  sessions?: SessionService;
}

/** Reads everything once. Never throws: a database failure is a reported state. */
export function opsSnapshot(deps: OpsDependencies): OpsSnapshot {
  const tools = readTools(deps.catalog);

  try {
    const runtime = emptyRuntimeDistribution();
    for (const view of deps.lifecycle.getAllRuntimeStates()) runtime[view.status] += 1;

    const backendCounts = deps.store.backends.counts();

    return {
      database: 'ok',
      backends: { ...backendCounts, runtime },
      tools,
      agents: deps.store.agents.counts(),
      sessions: deps.sessions === undefined ? null : deps.sessions.counts(),
      activity: {
        total: deps.store.activity.count(),
        byType: deps.store.activity.countByType(),
        byOutcome: deps.store.activity.countByOutcome(),
      },
    };
  } catch {
    // A closed or broken handle. Logged by the caller's error path if it becomes
    // a failure; here it is data: "the database is not answering".
    return { database: 'unavailable', backends: null, tools, agents: null, sessions: null, activity: null };
  }
}

/** The catalog is in memory, so it survives a database outage and is always reported. */
function readTools(catalog: ToolCatalog): ToolCounts {
  const all = catalog.listAll();
  const available = all.filter((tool) => tool.availability === 'available').length;

  return {
    total: all.length,
    available,
    unavailable: all.filter((tool) => tool.availability === 'unavailable').length,
    conflict: all.filter((tool) => tool.availability === 'conflict').length,
    backendsWithCatalog: catalog.backendIds().length,
    discoveryFailures: catalog.reports().filter((report) => report.status === 'failed').length,
  };
}

function emptyRuntimeDistribution(): Record<BackendStatus, number> {
  const distribution = {} as Record<BackendStatus, number>;
  for (const status of BACKEND_STATUSES) distribution[status] = 0;
  return distribution;
}

/** True when the handle answers a trivial read. Used by `/ready` and diagnostics. */
export function databaseResponds(store: Database): boolean {
  try {
    store.handle.prepare('SELECT 1 AS ok').get();
    return true;
  } catch {
    return false;
  }
}

/** Highest applied migration, or `undefined` when the ledger is unreadable. */
export function migrationVersion(store: Database): string | undefined {
  try {
    const row = store.handle.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: string | null;
    };
    return row.version ?? undefined;
  } catch {
    return undefined;
  }
}
