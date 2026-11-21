import type { BackendRuntimeStatus, IntegrationStatus } from '@/lib/api/types';

/**
 * One status vocabulary for the dashboard.
 *
 * `null` is a first-class status here. The API returns `null` when a storage
 * read failed, and rendering that as "0" or as "healthy" is the specific lie the
 * Phase 8 design exists to prevent. Anything that formats a count takes a
 * `number | null` and this type makes forgetting the `null` branch a type error.
 */

export type Tone = 'success' | 'warning' | 'error' | 'neutral' | 'info';

export type Availability = 'available' | 'unavailable';

export interface StatusLabel {
  label: string;
  tone: Tone;
}

/** The gateway as a whole, from `/overview`, `/ready`, or a failed request. */
export function gatewayStatus(input: {
  database: 'ok' | 'unavailable';
  status: 'operational' | 'degraded';
}): StatusLabel {
  if (input.database === 'unavailable') return { label: 'Degraded — storage unavailable', tone: 'error' };
  if (input.status === 'degraded') return { label: 'Degraded', tone: 'warning' };
  return { label: 'Operational', tone: 'success' };
}

const RUNTIME_LABELS: Record<BackendRuntimeStatus, StatusLabel> = {
  connected: { label: 'Connected', tone: 'success' },
  connecting: { label: 'Connecting', tone: 'info' },
  disconnecting: { label: 'Disconnecting', tone: 'info' },
  disconnected: { label: 'Disconnected', tone: 'neutral' },
  unhealthy: { label: 'Unhealthy', tone: 'warning' },
  error: { label: 'Error', tone: 'error' },
  disabled: { label: 'Disabled', tone: 'neutral' },
};

export function runtimeStatus(status: BackendRuntimeStatus): StatusLabel {
  return RUNTIME_LABELS[status];
}

const CONNECTION_LABELS: Record<IntegrationStatus, StatusLabel> = {
  connected: { label: 'Connected', tone: 'success' },
  pending: { label: 'Pending', tone: 'neutral' },
  connecting: { label: 'Connecting', tone: 'info' },
  disconnected: { label: 'Disconnected', tone: 'neutral' },
  error: { label: 'Error', tone: 'error' },
  reauthorization_required: { label: 'Reauthorization required', tone: 'warning' },
  disabled: { label: 'Disabled', tone: 'neutral' },
};

/**
 * A managed-integration connection status. The same honesty rule as backends:
 * these seven values are the whole state machine, so an unknown one is a
 * contract break, not a state to guess at.
 */
export function connectionStatus(status: IntegrationStatus): StatusLabel {
  return CONNECTION_LABELS[status];
}

export function availabilityStatus(value: 'available' | 'unavailable' | 'conflict'): StatusLabel {
  switch (value) {
    case 'available':
      return { label: 'Available', tone: 'success' };
    case 'unavailable':
      return { label: 'Unavailable', tone: 'neutral' };
    case 'conflict':
      return { label: 'Name conflict', tone: 'warning' };
  }
}

export function authenticationStatus(value: 'required' | 'unavailable'): StatusLabel {
  return value === 'required'
    ? { label: 'Agent auth required', tone: 'success' }
    : { label: 'Agent auth not configured', tone: 'warning' };
}

/**
 * Formats a count that may be unavailable. Returns `null` for `null` so the
 * caller must choose an "Unavailable" affordance instead of printing a zero.
 */
export function formatCount(value: number | null): string | null {
  return value === null ? null : new Intl.NumberFormat('en-US').format(value);
}

/** Uptime as a short, stable string. No relative-time locale drift between server and client. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Timestamps are rendered in UTC with an explicit suffix so the server and the
 * browser never disagree about the same instant.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}
