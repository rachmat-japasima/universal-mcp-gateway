import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/errors';
import type {
  BackendCounts,
  Diagnostics,
  GatewayHealth,
  Monitoring,
  MonitoringBackends,
  MonitoringHealth,
  MonitoringMetrics,
  MonitoringSessions,
  Readiness,
} from '@/lib/api/types';

/**
 * The monitoring page.
 *
 * The claims pinned here are the ones that would otherwise become a fabricated
 * status:
 *
 *  * liveness, readiness, dependency health, backend runtime and telemetry are
 *    separate sections — collapsing them would let a passing liveness probe
 *    imply readiness;
 *  * a failed read degrades its own card and never renders a zero;
 *  * readiness is trusted from its parsed body, because `fetch` does not throw on
 *    the documented `503`;
 *  * telemetry reads counters the gateway actually keeps, by exact metric and
 *    label — absent families read 0, which is a counter's true value, while a
 *    failed read renders "not read";
 *  * no percentage, rate, latency percentile, CPU or memory figure appears
 *    anywhere — those would be derived from one snapshot, not recorded in it.
 */

const getMonitoring = vi.fn();
const getMonitoringHealth = vi.fn();
const getMonitoringBackends = vi.fn();
const getMonitoringSessions = vi.fn();
const getMonitoringMetrics = vi.fn();
const getDiagnostics = vi.fn();
const fetchReadiness = vi.fn();
const fetchLiveness = vi.fn();

vi.mock('@/lib/api/endpoints', () => ({
  getMonitoring: () => getMonitoring(),
  getMonitoringHealth: () => getMonitoringHealth(),
  getMonitoringBackends: () => getMonitoringBackends(),
  getMonitoringSessions: () => getMonitoringSessions(),
  getMonitoringMetrics: () => getMonitoringMetrics(),
  getDiagnostics: () => getDiagnostics(),
}));
vi.mock('@/lib/api/client', () => ({
  fetchReadiness: () => fetchReadiness(),
  fetchLiveness: () => fetchLiveness(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/monitoring',
}));

const { default: MonitoringPage } = await import('@/app/(dashboard)/dashboard/monitoring/page');

const BACKEND = '11111111-1111-4111-8111-111111111111';

const backendCounts: BackendCounts = {
  total: 2,
  enabled: 1,
  disabled: 1,
  runtime: { connected: 1, connecting: 0, disconnecting: 0, disconnected: 0, unhealthy: 0, error: 0, disabled: 1 },
};

function monitoring(overrides: Partial<Monitoring> = {}): Monitoring {
  return {
    status: 'operational',
    service: { name: 'universal-mcp-gateway', version: '0.1.0' },
    runtime: { node: 'v26.13.1', platform: 'linux', uptimeMs: 3_723_000 },
    timestamp: '2026-11-21T00:00:00.000Z',
    database: 'ok',
    backends: backendCounts,
    sessions: { counts: { active: 3, expired: 1, terminated: 0, invalidated: 0 }, total: 4 },
    tools: { total: 9, available: 7, unavailable: 1, conflict: 1, backendsWithCatalog: 1, discoveryFailures: 0 },
    activity: { total: 12, byType: { 'tools.call': 9 }, byOutcome: { success: 10, failure: 2, denied: 0 } },
    ...overrides,
  };
}

function health(overrides: Partial<MonitoringHealth> = {}): MonitoringHealth {
  return { status: 'ok', database: 'ok', backends: backendCounts, timestamp: '2026-11-21T00:00:00.000Z', ...overrides };
}

function readiness(overrides: Partial<Readiness> = {}): Readiness {
  return {
    status: 'ready',
    checks: { database: 'ok', migrations: 'ok' },
    migrationVersion: '0005',
    timestamp: '2026-11-21T00:00:00.000Z',
    ...overrides,
  };
}

function liveness(overrides: Partial<GatewayHealth> = {}): GatewayHealth {
  return {
    status: 'ok',
    service: 'universal-mcp-gateway',
    version: '0.1.0',
    timestamp: '2026-11-21T00:00:00.000Z',
    mcp: { endpoint: '/mcp', backendCount: 2, status: 'ready', authentication: 'required' },
    ...overrides,
  };
}

function backends(overrides: Partial<MonitoringBackends> = {}): MonitoringBackends {
  return {
    counts: backendCounts,
    runtimes: [
      {
        backendId: BACKEND,
        status: 'connected',
        reconnectAttempts: 0,
        updatedAt: '2026-11-21T00:00:00.000Z',
      },
    ],
    discovery: [],
    conflicts: [],
    ...overrides,
  };
}

function sessions(overrides: Partial<MonitoringSessions> = {}): MonitoringSessions {
  return {
    available: true,
    counts: { active: 3, expired: 1, terminated: 0, invalidated: 0 },
    total: 4,
    ...overrides,
  };
}

function diagnostics(overrides: Partial<Diagnostics> = {}): Diagnostics {
  return {
    service: { name: 'universal-mcp-gateway', version: '0.1.0' },
    runtime: { node: 'v26.13.1', platform: 'linux', uptimeMs: 3_723_000 },
    timestamp: '2026-11-21T00:00:00.000Z',
    database: { status: 'ok', migrationVersion: '0005' },
    configuration: { status: 'ok', environment: 'production', logLevel: 'info' },
    backends: { registered: 2 },
    sessions: { total: 4 },
    tools: { available: 7 },
    authentication: 'required',
    limits: { requestBodyLimitBytes: 1_048_576, requestTimeoutMs: 30_000 },
    ...overrides,
  };
}

function metricsSnapshot(overrides: Partial<MonitoringMetrics> = {}): MonitoringMetrics {
  return {
    generatedAt: '2026-11-21T00:00:00.000Z',
    series: 6,
    dropped: 0,
    metrics: [
      {
        name: 'umg_tool_calls_total',
        type: 'counter',
        help: 'Tool calls by outcome and source type.',
        samples: [
          { labels: { outcome: 'success', source_type: 'mcp_backend' }, value: 9 },
          { labels: { outcome: 'success', source_type: 'managed_integration' }, value: 2 },
          { labels: { outcome: 'failure', source_type: 'mcp_backend' }, value: 2 },
          { labels: { outcome: 'failure', source_type: 'managed_integration' }, value: 1 },
          // Denials are counted before the catalog read, so they carry no
          // source type — the shape the card reads, not a sum.
          { labels: { outcome: 'denied' }, value: 1 },
        ],
      },
      {
        name: 'umg_auth_total',
        type: 'counter',
        help: 'Authentication attempts by surface and outcome.',
        samples: [{ labels: { surface: 'agent', outcome: 'failure' }, value: 3 }],
      },
      {
        name: 'umg_mcp_session_denied_total',
        type: 'counter',
        help: 'MCP session access denials.',
        samples: [{ labels: {}, value: 4 }],
      },
    ],
    recentErrors: [],
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of [
    getMonitoring,
    getMonitoringHealth,
    getMonitoringBackends,
    getMonitoringSessions,
    getMonitoringMetrics,
    getDiagnostics,
    fetchReadiness,
    fetchLiveness,
  ]) {
    mock.mockReset();
  }

  getMonitoring.mockResolvedValue(monitoring());
  getMonitoringHealth.mockResolvedValue(health());
  getMonitoringBackends.mockResolvedValue(backends());
  getMonitoringSessions.mockResolvedValue(sessions());
  getMonitoringMetrics.mockResolvedValue(metricsSnapshot());
  getDiagnostics.mockResolvedValue(diagnostics());
  fetchReadiness.mockResolvedValue(readiness());
  fetchLiveness.mockResolvedValue(liveness());
});

async function renderPage(): Promise<void> {
  render(await MonitoringPage());
}

describe('monitoring page', () => {
  it('keeps liveness, readiness and dependency health apart', async () => {
    await renderPage();

    expect(screen.getByText('Liveness')).toBeTruthy();
    expect(screen.getByText('Readiness')).toBeTruthy();
    expect(screen.getByText('Dependency health')).toBeTruthy();
    expect(screen.getByText('Backend runtime')).toBeTruthy();

    expect(screen.getByText('Process alive')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('Healthy')).toBeTruthy();
  });

  it('reports a not_ready 503 body as not ready, not as a missing gateway', async () => {
    // `fetch` does not throw on 503; the parsed document is the answer.
    fetchReadiness.mockResolvedValue(
      readiness({ status: 'not_ready', checks: { database: 'unavailable', migrations: 'unavailable' }, migrationVersion: undefined }),
    );

    await renderPage();

    expect(screen.getByText('Not ready')).toBeTruthy();
    // Liveness is a different probe and still passes.
    expect(screen.getByText('Process alive')).toBeTruthy();
    expect(screen.queryByText('Readiness could not be read')).toBeNull();
  });

  it('says readiness could not be read when the probe fails, while liveness stands', async () => {
    fetchReadiness.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getByText('Readiness could not be read')).toBeTruthy();
    expect(screen.getByText('Process alive')).toBeTruthy();
  });

  it('degrades one section when only its read fails', async () => {
    getMonitoringBackends.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getByText('Backend runtime could not be read')).toBeTruthy();
    // The snapshot card is a different read and survives.
    expect(screen.getByText('Healthy')).toBeTruthy();
    expect(screen.getByText('Process alive')).toBeTruthy();
  });

  it('never renders a zero for an unread snapshot count', async () => {
    getMonitoring.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getByText('The monitoring snapshot could not be read')).toBeTruthy();
    // Backends, tools available and uptime are all unavailable, and none of them
    // is rendered as 0.
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(3);
  });

  it('reports unavailable session tracking as such, not as zero active sessions', async () => {
    getMonitoringSessions.mockResolvedValue({
      available: false,
      counts: null,
      reason: 'Session tracking is not enabled.',
    });

    await renderPage();

    expect(screen.getByText('Not enabled')).toBeTruthy();
    expect(screen.getByText('Session tracking is not enabled.')).toBeTruthy();
  });

  it('renders diagnostics as the safe payload only', async () => {
    await renderPage();

    expect(screen.getByText('Diagnostics')).toBeTruthy();
    expect(screen.getByText('0005')).toBeTruthy();
    expect(screen.getByText('production')).toBeTruthy();
    expect(screen.getByText('info')).toBeTruthy();
    expect(screen.getByText('1048576')).toBeTruthy();
    expect(screen.getByText('30000')).toBeTruthy();
  });

  it('says diagnostics could not be read instead of guessing from its own config', async () => {
    getDiagnostics.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getByText('Diagnostics could not be read')).toBeTruthy();
  });

  it('renders telemetry counts from the snapshot, by exact metric and label', async () => {
    await renderPage();

    expect(screen.getByText('Telemetry')).toBeTruthy();
    // Five exact lookups on umg_tool_calls_total: success and failure split by
    // the closed source_type enum, denied without one (pre-resolution).
    const backendSuccess = screen.getByText('Tool calls (success · backends)').closest('div');
    expect(backendSuccess?.textContent).toContain('9');
    const integrationSuccess = screen.getByText('Tool calls (success · integrations)').closest('div');
    expect(integrationSuccess?.textContent).toContain('2');
    const backendFailure = screen.getByText('Tool calls (failure · backends)').closest('div');
    expect(backendFailure?.textContent).toContain('2');
    const integrationFailure = screen.getByText('Tool calls (failure · integrations)').closest('div');
    expect(integrationFailure?.textContent).toContain('1');
    const denied = screen.getByText('Tool calls (denied)').closest('div');
    expect(denied?.textContent).toContain('1');

    // An exact label lookup, not a sum over surfaces.
    const authFailures = screen.getByText('Agent authentication failures').closest('div');
    expect(authFailures?.textContent).toContain('3');

    expect(screen.getByText('No recent internal errors.')).toBeTruthy();
  });

  it('reads an absent series as a true zero, and says why the values reset', async () => {
    getMonitoringMetrics.mockResolvedValue(
      metricsSnapshot({
        metrics: [],
        recentErrors: [],
      }),
    );

    await renderPage();

    const success = screen.getByText('Tool calls (success · backends)').closest('div');
    expect(success?.textContent).toContain('0');
    expect(screen.getByText(/reset on restart/i)).toBeTruthy();
  });

  it('degrades the telemetry card alone when its read fails', async () => {
    getMonitoringMetrics.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getByText('Telemetry could not be read')).toBeTruthy();
    // The other questions still have their answers.
    expect(screen.getByText('Process alive')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
  });

  it('lists recent internal errors as codes and components, never messages', async () => {
    getMonitoringMetrics.mockResolvedValue(
      metricsSnapshot({
        recentErrors: [
          { code: 'INTERNAL_ERROR', component: 'api', at: '2026-11-21T00:00:01.000Z', requestId: 'r-1' },
          { code: 'BACKEND_TIMEOUT', component: 'lifecycle', at: '2026-11-21T00:00:00.000Z', requestId: 'r-2' },
        ],
      }),
    );

    await renderPage();

    expect(screen.getByText(/Recent internal errors/)).toBeTruthy();
    expect(screen.getByText(/INTERNAL_ERROR · api/)).toBeTruthy();
    expect(screen.getByText(/BACKEND_TIMEOUT · lifecycle/)).toBeTruthy();
    // Request ids are correlation handles, not content: they stay out of the card.
    expect(screen.queryByText(/r-1/)).toBeNull();
  });

  it('invents no rate, percentage, latency, CPU or memory figure', async () => {
    const { container } = render(await MonitoringPage());
    const text = container.textContent ?? '';

    for (const forbidden of ['%', 'req/s', 'requests per', 'p95', 'p99', 'ms avg', 'CPU', 'memory usage', 'MB']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
