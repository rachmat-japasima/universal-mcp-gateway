'use client';

import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { useCallback, useEffect, useState } from 'react';

import { StatusIndicator } from '@/components/ui/status-badge';
import type { Readiness } from '@/lib/api/types';
import type { StatusLabel } from '@/lib/utils/status';
import { isReadiness } from '@/lib/validation/readiness';

/**
 * Gateway status in the header.
 *
 * Two different questions are kept apart, exactly as the probes are:
 *
 *   * **Liveness** — `/health`. Is the process serving?
 *   * **Readiness** — `/ready`. Can it serve? Its `503` is a real answer
 *     (`status: "not_ready"`), so a non-2xx does *not* by itself mean the
 *     gateway is missing.
 *
 * That last point is the subtle part: an unreachable gateway also produces a
 * `503`, from the dashboard's own proxy, carrying an error envelope instead of a
 * readiness document. Both statuses are 503, so the payload shape decides which
 * state is reported.
 *
 * A disconnected *backend* is not a gateway failure: `/ready` deliberately
 * ignores optional backends, and so does this indicator. That is why "ready" stays
 * green with an empty registry.
 *
 * Polling is deliberately absent. The header value comes from the server render
 * and is refreshed on demand, so an idle dashboard is not a request generator.
 */

type ProbeState = { kind: 'checking' } | { kind: 'answered'; readiness: Readiness } | { kind: 'unreachable' };

function toStatus(state: ProbeState): StatusLabel {
  switch (state.kind) {
    case 'checking':
      return { label: 'Checking gateway', tone: 'info' };
    case 'unreachable':
      return { label: 'Gateway unreachable', tone: 'error' };
    case 'answered':
      return state.readiness.status === 'ready'
        ? { label: 'Gateway ready', tone: 'success' }
        : { label: 'Gateway not ready', tone: 'error' };
  }
}

function detailFor(state: ProbeState): string {
  switch (state.kind) {
    case 'checking':
      return 'Contacting the gateway readiness probe.';
    case 'unreachable':
      return 'The dashboard could not reach the gateway. Start it and retry.';
    case 'answered': {
      const { checks } = state.readiness;
      const ready = state.readiness.status === 'ready';
      const migration = state.readiness.migrationVersion;
      const storage = `database ${checks.database}, migrations ${checks.migrations}`;
      const suffix = migration === undefined ? '' : ` (schema ${migration})`;
      return ready
        ? `Readiness probe passed: ${storage}${suffix}. Disconnected backends do not affect readiness.`
        : `Readiness probe failed: ${storage}${suffix}.`;
    }
  }
}

export function GatewayStatus({ initial }: { initial: Readiness | null }): React.ReactElement {
  const [state, setState] = useState<ProbeState>(
    initial === null ? { kind: 'unreachable' } : { kind: 'answered', readiness: initial },
  );

  const refresh = useCallback(async () => {
    setState({ kind: 'checking' });

    try {
      const response = await fetch('/api/proxy/ready', {
        cache: 'no-store',
      });

      // Parsed exactly once. A malformed body throws here and is handled by
      // the catch below, so there is no second `json()` call to disagree with
      // this one.
      const body: unknown = await response.json();

      // Status alone cannot decide this. The proxy answers an unreachable
      // gateway with `503` + an error envelope, while the gateway's own
      // documented `503` is a real answer (`status: "not_ready"`, storage down)
      // with a readiness document in the body. Both pass through here as 503,
      // so the payload shape — not `response.ok` — is what separates "not
      // reachable" from "reachable but unhealthy". A non-2xx without a
      // readiness document is still rejected, which is why HTTP 500 and the
      // error envelope both land on `unreachable`.
      if (!isReadiness(body)) {
        setState({ kind: 'unreachable' });
        return;
      }

      setState({ kind: 'answered', readiness: body });
    } catch {
      setState({ kind: 'unreachable' });
    }
  }, []);

  // A stale tab must not keep claiming readiness. Re-probe when the tab returns.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };

    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const status = toStatus(state);
  const detail = detailFor(state);
  const isChecking = state.kind === 'checking';

  return (
    <HStack gap={2} align="center">
      <Tooltip content={detail}>
        <span className="inline-flex">
          <StatusIndicator status={status} />
        </span>
      </Tooltip>
      <Button
        // "Retry" is the truthful verb once the probe has failed; before that
        // the same control is a refresh. Both call `refresh`, the function the
        // initial server-rendered probe result was validated against.
        label={state.kind === 'unreachable' ? 'Retry' : 'Refresh status'}
        size="sm"
        variant="ghost"
        isDisabled={isChecking}
        isLoading={isChecking}
        onClick={() => void refresh()}
      />
    </HStack>
  );
}
