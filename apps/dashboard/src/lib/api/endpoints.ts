import { request, requestPage } from './client';
import type {
  ActivityEvent,
  ActivityQuery,
  AuditEvent,
  AuditQuery,
  Diagnostics,
  Monitoring,
  MonitoringBackends,
  MonitoringHealth,
  MonitoringMetrics,
  MonitoringRuntime,
  MonitoringSessions,
  Overview,
  Page,
  Settings,
} from './types';

/**
 * Endpoint modules. One function per documented route, no invented routes, and
 * no business logic: a filter the API does not support is not implemented here.
 *
 * This module holds the read endpoints used by server components. Backend
 * writes live in `lib/api/backends.ts` beside the reads they belong with, and are
 * performed from the browser's same-origin proxy rather than here.
 */

export const getOverview = (): Promise<Overview> => request<Overview>('/api/v1/overview');

export const getMonitoring = (): Promise<Monitoring> => request<Monitoring>('/api/v1/monitoring');

export const getMonitoringBackends = (): Promise<MonitoringBackends> =>
  request<MonitoringBackends>('/api/v1/monitoring/backends');

export const getMonitoringSessions = (): Promise<MonitoringSessions> =>
  request<MonitoringSessions>('/api/v1/monitoring/sessions');

export const getMonitoringRuntime = (): Promise<MonitoringRuntime> =>
  request<MonitoringRuntime>('/api/v1/monitoring/runtime');

export const getMonitoringHealth = (): Promise<MonitoringHealth> =>
  request<MonitoringHealth>('/api/v1/monitoring/health');

export const getMonitoringMetrics = (): Promise<MonitoringMetrics> =>
  request<MonitoringMetrics>('/api/v1/monitoring/metrics');

export const getDiagnostics = (): Promise<Diagnostics> => request<Diagnostics>('/api/v1/diagnostics');

export const getSettings = (): Promise<Settings> => request<Settings>('/api/v1/settings');

export const getActivity = (query: ActivityQuery = {}): Promise<Page<ActivityEvent>> =>
  requestPage<ActivityEvent>('/api/v1/activity', { ...query });

export const getActivityEvent = (eventId: string): Promise<ActivityEvent> =>
  request<ActivityEvent>(`/api/v1/activity/${encodeURIComponent(eventId)}`);

/** The list omits `metadata`; only the detail read renders it. */
export const getAudit = (query: AuditQuery = {}): Promise<Page<AuditEvent>> =>
  requestPage<AuditEvent>('/api/v1/audit', { ...query });

export const getAuditEvent = (eventId: string): Promise<AuditEvent> =>
  request<AuditEvent>(`/api/v1/audit/${encodeURIComponent(eventId)}`);
