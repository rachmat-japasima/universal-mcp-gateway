import type { DiscoveryReport, CatalogTool, ToolAvailability, ToolConflict, ToolDefinition } from '../domain/tool.js';
import type { ToolSourceReference } from '../integrations/source.js';
import { backendSource } from '../integrations/source.js';
import { publicToolName } from './namespacing.js';

/**
 * In-memory tool catalog.
 *
 * The catalog is a *derived* view: it holds nothing that cannot be rebuilt by
 * re-reading the sources. That is why it is not persisted (ADR-038) — a stored
 * catalog would be a claim about a process that no longer exists, exactly the
 * failure `recover()` exists to prevent for runtime rows.
 *
 * Structure: one immutable snapshot per source (backend or managed
 * connection), replaced wholesale. Readers take the current snapshot and never
 * see a half-updated source, and a discovery that fails leaves the previous
 * snapshot untouched.
 *
 * Snapshots are keyed by `"<sourceType>:<sourceId>"`, not the bare id. Backend
 * ids and connection ids live in different tables with no cross-table
 * uniqueness constraint, so the composite key is what makes "no id collisions
 * across sources" (ADR-048) structural rather than probabilistic: even a
 * freak duplicate id cannot let one source shadow another's tools.
 *
 * No locks: a snapshot swap is a single reference assignment, which Node's
 * single-threaded model makes atomic with respect to other handlers. Per-source
 * *work* serialization lives in the lifecycle manager's queue, not here.
 */

export interface SourceSnapshot {
  sourceType: 'mcp_backend' | 'managed_integration';
  sourceId: string;
  /** Every successfully parsed tool, keyed by its normalized original name. */
  tools: Map<string, CatalogTool>;
  /** MCP discovery report. Managed snapshots carry none in Phase 12: no report surface exists. */
  report?: DiscoveryReport;
}

/** Structural snapshot key: two sources with the same id can never overlap. */
export function sourceKey(sourceType: string, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

/** One visible reason for a withheld tool; used wherever a conflict is reported. */
const CONFLICT_REASON = 'The public name is claimed by more than one tool.';

export interface DiscoveryInput {
  backendId: string;
  now: string;
  /** Raw tools from the backend, already typed by the SDK. */
  tools: ToolDefinition[];
  /** Tools whose metadata could not be normalized into a name. */
  rejected: string[];
}

/** Same shape as `DiscoveryInput`, for a managed connection. */
export interface IntegrationDiscoveryInput {
  connectionId: string;
  now: string;
  tools: ToolDefinition[];
  rejected: string[];
}

/** Outcome of a discovery attempt: the replacement snapshot plus what changed. */
export interface DiscoveryOutcome {
  report: DiscoveryReport;
  added: string[];
  removed: string[];
  /** True when at least one tool's schema or description changed under a stable name. */
  changed: string[];
}

/** Cheaper outcome for managed snapshots: no discovery report exists to return. */
export interface IntegrationOutcome {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Collision policy: fail closed.
 *
 * If two tools produce the same public name, *both* are withheld. The
 * alternative — first-writer-wins, or a random suffix — would make routing
 * depend on discovery order, which is exactly the ambiguity the spec forbids.
 */
export function detectConflicts(snapshots: Iterable<SourceSnapshot>): Map<string, ToolConflict> {
  const claims = new Map<string, Array<{ sourceType: 'mcp_backend' | 'managed_integration'; sourceId: string; originalName: string }>>();

  for (const snapshot of snapshots) {
    for (const tool of snapshot.tools.values()) {
      const existing = claims.get(tool.publicName);
      const claimant = { sourceType: tool.sourceType, sourceId: tool.sourceId, originalName: tool.originalName };
      if (existing === undefined) {
        claims.set(tool.publicName, [claimant]);
      } else {
        existing.push(claimant);
      }
    }
  }

  const conflicts = new Map<string, ToolConflict>();
  for (const [publicName, claimants] of claims) {
    if (claimants.length > 1) {
      conflicts.set(publicName, {
        publicName,
        claimants: claimants
          .map((claimant) => ({
            sourceType: claimant.sourceType,
            sourceId: claimant.sourceId,
            ...(claimant.sourceType === 'mcp_backend' ? { backendId: claimant.sourceId } : {}),
            originalName: claimant.originalName,
          }))
          .sort(
            (a, b) => a.sourceId.localeCompare(b.sourceId) || a.originalName.localeCompare(b.originalName),
          ),
      });
    }
  }

  return conflicts;
}

/** Shared record construction for both source types. The only place `CatalogTool` is built. */
function buildForSource(
  source: ToolSourceReference,
  input: { now: string; tools: ToolDefinition[]; rejected: string[] },
): { tools: Map<string, CatalogTool>; rejected: string[] } {
  const tools = new Map<string, CatalogTool>();
  const rejected = [...input.rejected];

  for (const definition of input.tools) {
    const publicName = publicToolName(source.sourceId, definition.name);
    if (publicName === undefined) {
      rejected.push(definition.name.slice(0, 200));
      continue;
    }

    // Two originals inside one source collapsing onto one public name is the
    // same collision, one level down. Keep the first and reject the rest so the
    // source's own snapshot stays unambiguous.
    if ([...tools.values()].some((tool) => tool.publicName === publicName)) {
      rejected.push(definition.name.slice(0, 200));
      continue;
    }

    tools.set(definition.name, {
      ...definition,
      publicName,
      originalName: definition.name,
      sourceType: source.type,
      sourceId: source.sourceId,
      ...(source.type === 'mcp_backend' ? { backendId: source.sourceId } : {}),
      availability: 'available',
      discoveredAt: input.now,
      updatedAt: input.now,
    } as CatalogTool);
  }

  return { tools, rejected };
}

/** Turns raw backend tools into catalog records. Throws nothing: unnamed tools are reported. */
export function buildTools(input: DiscoveryInput): { tools: Map<string, CatalogTool>; rejected: string[] } {
  return buildForSource(backendSource(input.backendId), input);
}

/**
 * Turns connector-reported tools into catalog records (ADR-048 namespacing:
 * `<connection_id>__<tool_name>`, the same deterministic path MCP tools use,
 * so a client's stored name never changes meaning).
 */
export function buildIntegrationTools(
  input: IntegrationDiscoveryInput,
): { tools: Map<string, CatalogTool>; rejected: string[] } {
  return buildForSource({ type: 'managed_integration', sourceId: input.connectionId }, input);
}

export class ToolCatalog {
  private snapshots = new Map<string, SourceSnapshot>();
  private conflicts = new Map<string, ToolConflict>();

  /**
   * Replaces one source's snapshot. Callers must have built the snapshot from a
   * successful discovery; a failure path calls `remove` instead, so a partial
   * list can never replace a good one.
   *
   * Overloaded on source type: an MCP replacement reads back its discovery
   * report (conflict counts are catalog-wide and only knowable after
   * `reindex`); a managed replacement has no report surface in Phase 12 and
   * answers with the diff alone.
   */
  replace(snapshot: SourceSnapshot & { sourceType: 'mcp_backend' }): DiscoveryOutcome;
  replace(snapshot: SourceSnapshot & { sourceType: 'managed_integration' }): IntegrationOutcome;
  replace(snapshot: SourceSnapshot): DiscoveryOutcome | IntegrationOutcome {
    const key = sourceKey(snapshot.sourceType, snapshot.sourceId);
    const previous = this.snapshots.get(key);
    const before = previous === undefined ? new Map<string, CatalogTool>() : previous.tools;

    const added = [...snapshot.tools.keys()].filter((name) => !before.has(name)).sort();
    const removed = [...before.keys()].filter((name) => !snapshot.tools.has(name)).sort();
    const changed = [...snapshot.tools.keys()].filter((name) => {
      const old = before.get(name);
      return old !== undefined && fingerprint(old) !== fingerprint(snapshot.tools.get(name)!);
    });

    this.snapshots.set(key, snapshot);
    this.reindex();

    if (snapshot.sourceType === 'mcp_backend') {
      // Read back rather than returning `snapshot.report`: conflict counts are
      // catalog-wide and only knowable after `reindex`.
      return { report: this.reportFor(snapshot.sourceId)!, added, removed, changed: changed.sort() };
    }
    return { added, removed, changed: changed.sort() };
  }

  /**
   * Drops a source entirely: its tools stop being listed and stop being
   * callable in the same instant. A stored "last known" list would be exactly
   * the stale mapping the spec forbids.
   */
  remove(ref: ToolSourceReference): boolean {
    const removed = this.snapshots.delete(sourceKey(ref.type, ref.sourceId));
    if (removed) this.reindex();
    return removed;
  }

  /** Callable tools only, sorted by public name so `tools/list` is stable. */
  listAvailable(): CatalogTool[] {
    return [...this.callable()].sort((a, b) => a.publicName.localeCompare(b.publicName));
  }

  /** Everything known, including withheld tools. For the management API. */
  listAll(): CatalogTool[] {
    const all: CatalogTool[] = [];
    for (const snapshot of this.snapshots.values()) {
      for (const tool of snapshot.tools.values()) {
        // One row per tool. A conflicted tool keeps its own metadata but is
        // reported as withheld, so the API cannot show it as available.
        all.push(
          this.conflicts.has(tool.publicName)
            ? { ...tool, availability: 'conflict', unavailableReason: CONFLICT_REASON }
            : tool,
        );
      }
    }
    return all.sort((a, b) => a.publicName.localeCompare(b.publicName) || a.sourceId.localeCompare(b.sourceId));
  }

  /** Resolves a public name to a routable tool, or explains why it is not routable. */
  resolve(publicName: string): { tool: CatalogTool } | { reason: 'unknown' | 'conflict' | 'unavailable'; detail?: string } {
    const conflict = this.conflicts.get(publicName);
    if (conflict !== undefined) {
      return { reason: 'conflict', detail: CONFLICT_REASON };
    }

    for (const snapshot of this.snapshots.values()) {
      for (const tool of snapshot.tools.values()) {
        if (tool.publicName !== publicName) continue;
        if (tool.availability !== 'available') {
          return { reason: 'unavailable', detail: tool.unavailableReason ?? 'The tool is not currently available.' };
        }
        return { tool };
      }
    }

    return { reason: 'unknown' };
  }

  listByBackend(backendId: string): CatalogTool[] {
    return [...(this.snapshots.get(sourceKey('mcp_backend', backendId))?.tools.values() ?? [])].sort((a, b) =>
      a.publicName.localeCompare(b.publicName),
    );
  }

  reportFor(backendId: string): DiscoveryReport | undefined {
    const report = this.snapshots.get(sourceKey('mcp_backend', backendId))?.report;
    if (report === undefined) return undefined;
    return { ...report, conflictCount: this.conflictsOf(backendId) };
  }

  reports(): DiscoveryReport[] {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.report !== undefined && snapshot.sourceType === 'mcp_backend')
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
      .flatMap((snapshot) => {
        const report = this.reportFor(snapshot.sourceId);
        return report === undefined ? [] : [report];
      });
  }

  /** How many of a backend's tools are withheld because their public name is shared. */
  conflictsOf(backendId: string): number {
    let count = 0;
    for (const conflict of this.conflicts.values()) {
      if (
        conflict.claimants.some((claimant) => claimant.sourceType === 'mcp_backend' && claimant.sourceId === backendId)
      )
        count += 1;
    }
    return count;
  }

  conflicts$(): ToolConflict[] {
    return [...this.conflicts.values()].sort((a, b) => a.publicName.localeCompare(b.publicName));
  }

  /** Backends currently holding a snapshot. Connection ids are excluded: this counts backends. */
  backendIds(): string[] {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.sourceType === 'mcp_backend')
      .map((snapshot) => snapshot.sourceId)
      .sort();
  }

  get size(): number {
    return this.listAvailable().length;
  }

  /** Callable = available and not shadowed by a conflict. */
  private *callable(): Generator<CatalogTool> {
    for (const snapshot of this.snapshots.values()) {
      for (const tool of snapshot.tools.values()) {
        if (tool.availability === 'available' && !this.conflicts.has(tool.publicName)) yield tool;
      }
    }
  }

  private reindex(): void {
    this.conflicts = detectConflicts(this.snapshots.values());
  }
}

/** Everything that would make a stored routing decision wrong if it changed. */
function fingerprint(tool: CatalogTool): string {
  return JSON.stringify([
    tool.description ?? '',
    tool.inputSchema,
    tool.outputSchema ?? null,
    tool.annotations ?? null,
    tool.execution ?? null,
    tool.title ?? '',
    tool.availability satisfies ToolAvailability,
  ]);
}
