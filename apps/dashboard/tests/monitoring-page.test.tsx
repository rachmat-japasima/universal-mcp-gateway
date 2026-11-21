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
  MonitoringSessions,
  Readiness,
} from '@/lib/api/types';

/**
 * The monitoring page.
 *
 * The claims pinned here are the ones that would otherwise become a fabricated
 * status:
 *
 *  * liveness, readiness, dependency health and backend runtime are four separate
 *    sections — collapsing them would let a passing liveness probe imply readiness;
 *  * a failed read degrades its own card and never renders a zero;
 *  * readiness is trusted from its parsed body, because `fetch` does not throw on
 *    the documented `503`;
 *  * no percentage, rate, latency, CPU or memory figure appears anywhere — the
 *    gateway collects none, so any such number would be invented.
 */

const getMonitoring = vi.fn();
const getMonitoringHealth = vi.fn();
const getMonitoringBackends = vi.fn();
const getMonitoringSessions = vi.fn();
const getDiagnostics = vi.fn();
const fetchReadiness = vi.fn();
const fetchLiveness = vi.fn();

vi.mock('@/lib/api/endpoints', () => ({
  getMonitoring: () => getMonitoring(),
  getMonitoringHealth: () => getMonitoringHealth(),
  getMonitoringBackends: () => getMonitoringBackends(),
  getMonitoringSessions: () => getMonitoringSessions(),
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

beforeEach(() => {
  for (const mock of [
    getMonitoring,
    getMonitoringHealth,
    getMonitoringBackends,
    getMonitoringSessions,
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

  it('invents no rate, percentage, latency, CPU or memory figure', async () => {
    const { container } = render(await MonitoringPage());
    const text = container.textContent ?? '';

    for (const forbidden of ['%', 'req/s', 'requests per', 'p95', 'p99', 'ms avg', 'CPU', 'memory usage', 'MB']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
