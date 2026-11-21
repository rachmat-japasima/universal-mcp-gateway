import type { Metadata } from 'next';

import { RefreshButton } from '@/components/feedback/refresh-button';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { fetchLiveness, fetchReadiness } from '@/lib/api/client';
import {
  getDiagnostics,
  getMonitoring,
  getMonitoringBackends,
  getMonitoringHealth,
  getMonitoringMetrics,
  getMonitoringSessions,
} from '@/lib/api/endpoints';
import type {
  GatewayHealth,
  Monitoring,
  MonitoringBackends,
  MonitoringHealth,
  MonitoringMetrics,
  MonitoringSessions,
  Readiness,
} from '@/lib/api/types';
import { DiagnosticsPanel } from '@/features/monitoring/diagnostics-panel';
import { MonitoringContent } from '@/features/monitoring/monitoring-content';
import { settled, type Read } from '@/features/monitoring/read';

export const metadata: Metadata = { title: 'Monitoring' };

export const dynamic = 'force-dynamic';

/**
 * Monitoring and diagnostics.
 *
 * Eight independent reads, deliberately not sequenced into one:
 *
 *   * `GET /health`              — liveness, outside the API prefix, no envelope
 *   * `GET /ready`               — readiness, `200` or `503` with its own body
 *   * `/monitoring`              — the whole-process snapshot
 *   * `/monitoring/health`       — storage plus backend counts
 *   * `/monitoring/backends`     — per-backend runtime state
 *   * `/monitoring/sessions`     — session counts, `available: false` when unwired
 *   * `/monitoring/metrics`      — in-memory telemetry aggregates
 *   * `/diagnostics`             — the safe bug-report facts
 *
 * They run concurrently and settle independently, so one failing endpoint
 * degrades one card. Sequencing them would make the slowest endpoint the page's
 * latency, and a shared try/catch would make one failure hide the other seven
 * answers — which are still true even when a neighbour is down.
 *
 * **Nothing here is fabricated.** The telemetry card reads counters the
 * gateway actually keeps (`features.metrics` is `true` in `/settings`), and
 * nothing else derives a figure: no percentage, request rate, percentile, CPU
 * or memory number, and no chart. A rate or trend would be arithmetic on one
 * snapshot of an in-memory registry that resets on restart — the honest
 * presentation is the count itself. Historical metrics are deferred rather
 * than faked; see `docs/DASHBOARD.md`.
 *
 * `/health` and `/ready` are read raw, not through the data-envelope client:
 * neither is inside `/api/v1`, and readiness answers `503` with a real body. The
 * shape is validated by `isReadiness`, because the dashboard's own proxy also
 * answers `503` — with an error envelope — when the gateway is not there at all.
 */
export default async function Page(): Promise<React.ReactElement> {
  const [monitoring, health, readiness, liveness, backends, sessions, metrics, diagnostics] = await Promise.allSettled([
    getMonitoring(),
    getMonitoringHealth(),
    fetchReadiness(),
    fetchLiveness(),
    getMonitoringBackends(),
    getMonitoringSessions(),
    getMonitoringMetrics(),
    getDiagnostics(),
  ]);

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Monitoring"
          description="Five different questions, kept apart: liveness, readiness, dependency health, backend runtime, and telemetry. Every value is read from the gateway now; nothing is sampled, averaged, or charted."
          actions={<RefreshButton label="Refresh monitoring" />}
        />

        <MonitoringContent
          monitoring={settled(monitoring) as Read<Monitoring>}
          health={settled(health) as Read<MonitoringHealth>}
          readiness={settled(readiness) as Read<Readiness>}
          liveness={settled(liveness) as Read<GatewayHealth>}
          backends={settled(backends) as Read<MonitoringBackends>}
          sessions={settled(sessions) as Read<MonitoringSessions>}
          telemetry={settled(metrics) as Read<MonitoringMetrics>}
          diagnostics={<DiagnosticsPanel diagnostics={settled(diagnostics)} />}
        />
      </div>
    </PageContainer>
  );
}
