import { monitorEventLoopDelay, type ELDHistogram } from 'node:perf_hooks';

import { correlationContext } from './context.js';

/**
 * Metrics registry (Phase 11).
 *
 * Design, in one paragraph: a hand-rolled, in-memory registry — counters,
 * gauges, histograms, plus export-time collectors for values that only exist
 * at read time (uptime, memory, live counts). No dependency, no SQLite: a
 * metric is a process-local aggregate that resets on restart, and pretending
 * it survives would be a fabrication. Every label is a closed enum or a
 * bounded pattern, so the number of series is bounded by construction; a
 * violation is dropped and counted in `umg_metrics_dropped_total` rather than
 * failing the request — instrumentation must never break the request path.
 *
 * What is deliberately NOT a label: tool names, tool arguments, request /
 * session / credential ids, agent ids, backend ids, and any user input. Those
 * belong to activity rows and logs, which have the request id to correlate.
 */

const METRIC_PREFIX = 'umg_';

/** One label's rule. `enum` is the closed set; `pattern` bounds the shape. */
export interface LabelRule {
  enum?: readonly string[];
  pattern?: RegExp;
}

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricSpec {
  name: string;
  help: string;
  type: MetricType;
  labels?: Record<string, LabelRule>;
  /** Max distinct label combinations kept; new series beyond it are dropped. */
  maxSeries?: number;
  /** Histogram upper bounds in ms. Shared default keeps exports comparable. */
  buckets?: number[];
}

export const DEFAULT_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

interface Series {
  labels: Record<string, string>;
  value: number;
  /** Histogram only: non-cumulative per-bucket counts, aligned to `buckets`. */
  bucketCounts?: number[];
  sum?: number;
  count?: number;
}

/** Bounded recent-error ring: what an operator sees in diagnostics. */
export interface RecentError {
  code: string;
  component: string;
  at: string;
  requestId?: string;
}

const RECENT_ERROR_LIMIT = 20;
const DEFAULT_MAX_SERIES = 256;
const SAFE_TEXT = /^[\w. -]{1,120}$/;

export class Metrics {
  private readonly specs = new Map<string, MetricSpec>();
  private readonly series = new Map<string, Map<string, Series>>();
  private readonly collectors = new Map<string, () => CollectorSample[]>();
  private readonly recentErrors: RecentError[] = [];
  private droppedCount = 0;
  private eventLoop: ELDHistogram | undefined;

  /** Defines a metric. Idempotent redefinition is ignored (tests, hot reload). */
  define(spec: MetricSpec): void {
    if (this.specs.has(spec.name)) return;
    this.specs.set(spec.name, {
      ...spec,
      name: spec.name.startsWith(METRIC_PREFIX) ? spec.name : `${METRIC_PREFIX}${spec.name}`,
      maxSeries: spec.maxSeries ?? DEFAULT_MAX_SERIES,
      buckets: spec.type === 'histogram' ? (spec.buckets ?? DEFAULT_BUCKETS) : undefined,
    });
  }

  /** Counter increment. Never throws; an invalid series is dropped and counted. */
  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    this.mutate(name, labels, (series) => {
      series.value += value;
    });
  }

  /** Gauge absolute set. */
  set(name: string, labels: Record<string, string> = {}, value: number): void {
    this.mutate(name, labels, (series) => {
      series.value = value;
    });
  }

  /** Gauge relative adjust (in-flight counters: +1 before, −1 after). */
  adjust(name: string, labels: Record<string, string> = {}, delta: number): void {
    this.mutate(name, labels, (series) => {
      series.value += delta;
    });
  }

  /** Histogram observation in milliseconds. */
  observe(name: string, labels: Record<string, string> = {}, ms: number): void {
    this.mutate(name, labels, (series, spec) => {
      const buckets = spec.buckets!;
      let index = buckets.findIndex((bound) => ms <= bound);
      if (index === -1) index = buckets.length;
      series.bucketCounts![index] += 1;
      series.sum! += ms;
      series.count! += 1;
    });
  }

  /**
   * Export-time collector: supplies gauge values that only exist at read time.
   *
   * Keyed, so re-registering replaces rather than accumulates: the registry
   * is a process singleton and gateway assembly runs more than once in a test
   * process, and a stale collector would either export a closed store's view
   * or emit the same metric twice. Never a write path, so a throwing collector
   * is a bug in the collector, caught and counted here rather than failing an
   * export.
   */
  collect(key: string, collector: () => CollectorSample[]): void {
    this.collectors.set(key, collector);
  }

  /**
   * The one write path used from error boundaries: bumps
   * `umg_errors_total{code}` and keeps a bounded ring of the most recent
   * entries (code, component, time, request id — never a message, which is
   * where secrets and user input leak).
   */
  recordError(code: string, component: string): void {
    this.increment('umg_errors_total', { code, component });
    this.recentErrors.push({
      code,
      component,
      at: new Date().toISOString(),
      ...(correlationContext()?.requestId === undefined ? {} : { requestId: correlationContext()!.requestId }),
    });
    if (this.recentErrors.length > RECENT_ERROR_LIMIT) this.recentErrors.shift();
  }

  /** The ring, newest last. A copy, so the caller cannot mutate registry state. */
  recentErrorList(): RecentError[] {
    return [...this.recentErrors];
  }

  seriesCount(): number {
    let total = 0;
    for (const series of this.series.values()) total += series.size;
    return total;
  }

  dropped(): number {
    return this.droppedCount;
  }

  /** Event-loop delay sampling. Started at assembly, stopped in `close()`. */
  start(): void {
    // Node 26: the API is `enable()`/`disable()`. `mean` is `NaN` until the
    // first sample, which the collectors below handle by omitting the line.
    this.eventLoop = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoop.enable();
  }

  stop(): void {
    this.eventLoop?.disable();
    this.eventLoop = undefined;
  }

  /** Live event-loop delay samples, or `undefined` when not started/no data. */
  eventLoopDelay(): { mean: number; p99: number } | undefined {
    if (this.eventLoop === undefined) return undefined;
    const mean = this.eventLoop.mean;
    if (!Number.isFinite(mean)) return undefined;
    return { mean, p99: this.eventLoop.percentile(99) };
  }

  /** Prometheus text format 0.0.4. Never throws. */
  prometheus(): string {
    const lines: string[] = [];

    for (const spec of this.specs.values()) {
      lines.push(`# HELP ${spec.name} ${spec.help}`);
      lines.push(`# TYPE ${spec.name} ${spec.type}`);
      const series = [...(this.series.get(spec.name)?.values() ?? [])].sort((a, b) =>
        seriesKey(a.labels) < seriesKey(b.labels) ? -1 : 1,
      );
      for (const sample of series) {
        if (spec.type === 'histogram') {
          const buckets = spec.buckets!;
          const labels = labelList(sample.labels);
          let cumulative = 0;
          sample.bucketCounts!.forEach((count, index) => {
            cumulative += count;
            lines.push(
              `${spec.name}_bucket{${labels ? `${labels},` : ''}le="${buckets[index]}"} ${cumulative}`,
            );
          });
          lines.push(`${spec.name}_bucket{${labels ? `${labels},` : ''}le="+Inf"} ${sample.count}`);
          const suffix = labels ? `{${labels}}` : '';
          lines.push(`${spec.name}_sum${suffix} ${sample.sum}`);
          lines.push(`${spec.name}_count${suffix} ${sample.count}`);
        } else if (Number.isFinite(sample.value)) {
          const labels = labelList(sample.labels);
          lines.push(`${spec.name}${labels ? `{${labels}}` : ''} ${sample.value}`);
        }
      }
    }

    for (const samples of this.collectSamples()) {
      for (const sample of samples) {
        if (!Number.isFinite(sample.value)) continue; // e.g. event-loop mean before the first sample
        lines.push(`# HELP ${sample.name} ${sample.help}`);
        lines.push(`# TYPE ${sample.name} gauge`);
        lines.push(`${sample.name}${labelList(sample.labels ?? {}) ? `{${labelList(sample.labels ?? {})}}` : ''} ${sample.value}`);
      }
    }

    return `${lines.join('\n')}\n`;
  }

  /**
   * JSON view for the management API. Same numbers as `prometheus()`, plus
   * the registry facts diagnostics reports (series, dropped, recent errors).
   */
  snapshot(): MetricsSnapshot {
    const metrics: MetricsSnapshotMetric[] = [];

    for (const spec of this.specs.values()) {
      const series = [...(this.series.get(spec.name)?.values() ?? [])].sort((a, b) =>
        seriesKey(a.labels) < seriesKey(b.labels) ? -1 : 1,
      );
      metrics.push({
        name: spec.name,
        type: spec.type,
        help: spec.help,
        samples: series.map((sample) => ({
          labels: sample.labels,
          ...(spec.type === 'histogram'
            ? {
                count: sample.count,
                sum: sample.sum,
                buckets: spec.buckets!.map((le, index) => ({ le, count: sample.bucketCounts![index] })),
              }
            : { value: Number.isFinite(sample.value) ? sample.value : null }),
        })),
      });
    }

    for (const samples of this.collectSamples()) {
      for (const sample of samples) {
        if (!Number.isFinite(sample.value)) continue;
        metrics.push({ name: sample.name, type: 'gauge', help: sample.help, samples: [{ labels: sample.labels, value: sample.value }] });
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      series: this.seriesCount(),
      dropped: this.dropped(),
      metrics,
      recentErrors: this.recentErrorList(),
    };
  }

  private collectSamples(): CollectorSample[][] {
    const collected: CollectorSample[][] = [];
    for (const collector of this.collectors.values()) {
      try {
        const samples = collector().filter((sample) => SAFE_TEXT.test(sample.name) && sample.name !== '');
        if (samples.length > 0) collected.push(samples);
      } catch {
        this.droppedCount += 1;
      }
    }
    return collected;
  }

  /** Shared validation + mutation path. The only place a series is created. */
  private mutate(
    name: string,
    labels: Record<string, string>,
    apply: (series: Series, spec: MetricSpec) => void,
  ): void {
    try {
      const spec = this.specs.get(name);
      if (spec === undefined) {
        // An undefined metric is an instrumentation bug; counted, never silent.
        // Direct increment only: `drop()` writes into a metric that does not
        // exist here, which would recurse.
        this.droppedCount += 1;
        return;
      }

      const validated = this.validateLabels(spec, labels);
      if (validated === undefined) {
        this.drop();
        return;
      }

      const key = seriesKey(validated);
      const all = this.series.get(name) ?? new Map<string, Series>();
      let sample = all.get(key);

      if (sample === undefined) {
        if (all.size >= spec.maxSeries!) {
          this.drop();
          return;
        }
        sample =
          spec.type === 'histogram'
            ? { labels: validated, value: 0, bucketCounts: new Array(spec.buckets!.length).fill(0), sum: 0, count: 0 }
            : { labels: validated, value: 0 };
        all.set(key, sample);
        this.series.set(name, all);
      }

      apply(sample, spec);
    } catch {
      // The registry must never break a request; a dropped observation is the
      // honest outcome of an instrumentation bug.
      this.droppedCount += 1;
    }
  }

  /** One path for every drop, so the counter is always the whole truth. */
  private drop(): void {
    this.droppedCount += 1;

    // Written directly rather than through `increment`, which would re-enter
    // the undefined-spec path on a bare registry and double-count the drop.
    if (!this.specs.has('umg_metrics_dropped_total')) return;

    const all = this.series.get('umg_metrics_dropped_total') ?? new Map<string, Series>();
    const sample = all.get('') ?? { labels: {}, value: 0 };
    sample.value += 1;
    all.set('', sample);
    this.series.set('umg_metrics_dropped_total', all);
  }

  /** Closed-set enforcement: unknown keys and out-of-enum values are dropped. */
  private validateLabels(spec: MetricSpec, labels: Record<string, string>): Record<string, string> | undefined {
    const validated: Record<string, string> = {};

    for (const [key, rule] of Object.entries(spec.labels ?? {})) {
      const value = labels[key];
      if (value === undefined) continue;
      if (
        typeof value !== 'string' ||
        value.length > 64 ||
        (rule.enum !== undefined && !rule.enum.includes(value)) ||
        (rule.pattern !== undefined && !rule.pattern.test(value))
      ) {
        return undefined;
      }
      validated[key] = value;
    }

    for (const key of Object.keys(labels)) {
      if (!(key in (spec.labels ?? {}))) return undefined;
    }

    return validated;
  }
}

export interface CollectorSample {
  name: string;
  help: string;
  labels?: Record<string, string>;
  value: number;
}

export interface MetricsSnapshotMetric {
  name: string;
  type: MetricType | 'gauge';
  help: string;
  samples: Array<Record<string, unknown>>;
}

export interface MetricsSnapshot {
  generatedAt: string;
  series: number;
  dropped: number;
  metrics: MetricsSnapshotMetric[];
  recentErrors: RecentError[];
}

function seriesKey(labels: Record<string, string>): string {
  return labelList(labels);
}

function labelList(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}="${labels[key]}"`)
    .join(',');
}

/** HTTP methods the gateway records. Anything else is dropped by validation. */
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/** Route classes, not route templates: a closed set is the point. */
export const ROUTE_CLASSES = ['health', 'ready', 'metrics', 'mcp', 'api', 'unmatched'] as const;

/** MCP methods the gateway itself executes. SDK-answered pings are not counted. */
const MCP_METHODS = ['initialize', 'tools.list', 'tools.call'] as const;

const ERROR_CODE_PATTERN = /^[A-Z][A-Z_]{0,63}$/;
const STATUS_PATTERN = /^\d{3}$/;

/**
 * The gateway's metric families. One definition site, so the vocabulary cannot
 * drift between writer (instrumentation) and reader (export).
 */
export function createGatewayMetrics(): Metrics {
  const m = new Metrics();

  m.define({
    name: 'umg_http_requests_total',
    help: 'HTTP requests by method, route class and status.',
    type: 'counter',
    labels: {
      method: { enum: HTTP_METHODS },
      route: { enum: ROUTE_CLASSES },
      status: { pattern: STATUS_PATTERN },
    },
  });
  m.define({
    name: 'umg_http_request_duration_ms',
    help: 'HTTP request duration by route class, in milliseconds.',
    type: 'histogram',
    labels: { route: { enum: ROUTE_CLASSES } },
  });
  m.define({ name: 'umg_http_requests_inflight', help: 'HTTP requests currently being served.', type: 'gauge' });

  m.define({
    name: 'umg_mcp_method_total',
    help: 'MCP requests by method and outcome. tools.list and tools/call at the gateway handlers; initialize at session creation — the only outcome the gateway owns, since the SDK answers initialize itself. SDK-answered pings and notifications are not counted.',
    type: 'counter',
    labels: { method: { enum: MCP_METHODS }, outcome: { enum: ['success', 'failure', 'denied'] } },
  });
  m.define({
    name: 'umg_mcp_method_duration_ms',
    help: 'MCP method handling duration in milliseconds.',
    type: 'histogram',
    labels: { method: { enum: MCP_METHODS } },
  });
  // `umg_mcp_sessions_active`, `umg_backend_runtime` and the process gauges are
  // collector-only (registered in `createGatewayMetrics` / gateway assembly):
  // their values exist only at read time, and defining a spec would emit a
  // second, empty metric family with the same name.
  m.define({ name: 'umg_mcp_session_denied_total', help: 'MCP session access denials (ownership, liveness, credential state).', type: 'counter' });

  m.define({
    name: 'umg_tool_calls_total',
    help: 'Tool calls by outcome. Tool names are never a label; per-tool history is the activity table.',
    type: 'counter',
    labels: { outcome: { enum: ['success', 'failure', 'denied'] } },
  });
  m.define({ name: 'umg_tool_call_duration_ms', help: 'End-to-end tool call duration in milliseconds.', type: 'histogram' });
  m.define({
    name: 'umg_tool_failures_total',
    help: 'Failed tool calls by stable error code (includes timeouts and cancellations).',
    type: 'counter',
    labels: { code: { pattern: ERROR_CODE_PATTERN } },
  });

  m.define({
    name: 'umg_backend_connections_total',
    help: 'Backend connection attempts by outcome.',
    type: 'counter',
    labels: { outcome: { enum: ['success', 'failure'] } },
  });
  m.define({
    name: 'umg_backend_reconnects_total',
    help: 'Automatic reconnect attempts by outcome.',
    type: 'counter',
    labels: { outcome: { enum: ['success', 'failure'] } },
  });
  m.define({ name: 'umg_backend_disconnects_total', help: 'Backend disconnections, whatever the reason.', type: 'counter' });
  m.define({
    name: 'umg_backend_changes_total',
    help: 'Backend enable/disable configuration changes.',
    type: 'counter',
    labels: { action: { enum: ['enabled', 'disabled'] } },
  });

  m.define({
    name: 'umg_auth_total',
    help: 'Authentication attempts by surface and outcome.',
    type: 'counter',
    labels: { surface: { enum: ['agent', 'operator'] }, outcome: { enum: ['success', 'failure'] } },
  });
  m.define({ name: 'umg_credentials_revoked_total', help: 'Agent credentials revoked (direct revocation or rotation).', type: 'counter' });
  m.define({
    name: 'umg_authz_denials_total',
    help: 'Authorization denials by surface.',
    type: 'counter',
    labels: { surface: { enum: ['tool', 'session'] } },
  });

  m.define({
    name: 'umg_errors_total',
    help: 'Errors surfaced to a client, by stable code. Messages are never labels.',
    type: 'counter',
    labels: { code: { pattern: ERROR_CODE_PATTERN }, component: { pattern: SAFE_TEXT } },
  });
  m.define({ name: 'umg_metrics_dropped_total', help: 'Metric observations dropped by validation or the series cap, so under-counting is visible.', type: 'counter' });

  // Process facts, collected at export time: they only exist "now".
  m.collect('process', () => {
    const memory = process.memoryUsage();
    const samples: CollectorSample[] = [
      { name: 'umg_process_uptime_seconds', help: 'Process uptime in seconds.', value: process.uptime() },
      { name: 'umg_process_memory_rss_bytes', help: 'Resident set size in bytes.', value: memory.rss },
      { name: 'umg_process_memory_heap_used_bytes', help: 'Used V8 heap in bytes.', value: memory.heapUsed },
      { name: 'umg_process_memory_heap_total_bytes', help: 'Total V8 heap in bytes.', value: memory.heapTotal },
      { name: 'umg_metrics_series', help: 'Distinct metric series currently kept.', value: m.seriesCount() },
    ];
    const delay = m.eventLoopDelay();
    if (delay !== undefined) {
      samples.push(
        { name: 'umg_node_eventloop_delay_mean_ms', help: 'Mean event-loop delay in milliseconds.', value: delay.mean },
        { name: 'umg_node_eventloop_delay_p99_ms', help: '99th percentile event-loop delay in milliseconds.', value: delay.p99 },
      );
    }
    return samples;
  });

  return m;
}

/**
 * The process-wide registry. Deliberately a module singleton (like a metrics
 * registry in any runtime): it is *not* request state — per-request isolation
 * is what `AsyncLocalStorage` correlation is for — and every writer from any
 * assembly must land in the same counters for the numbers to mean anything.
 * Tests construct fresh instances with `new Metrics()` / `createGatewayMetrics()`.
 */
export const metrics = createGatewayMetrics();
