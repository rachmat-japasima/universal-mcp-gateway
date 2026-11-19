import { request, requestPage } from './client';
import type {
  ActivityEvent,
  AuditEvent,
  Diagnostics,
  Monitoring,
  MonitoringBackends,
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
 * Only read endpoints are wrapped, because Phase 9 ships no mutation UI. The
 * write endpoints exist on the gateway; adding them here without a caller would
 * be untested surface area.
 */

export const getOverview = (): Promise<Overview> => request<Overview>('/api/v1/overview');

export const getMonitoring = (): Promise<Monitoring> => request<Monitoring>('/api/v1/monitoring');

export const getMonitoringBackends = (): Promise<MonitoringBackends> =>
  request<MonitoringBackends>('/api/v1/monitoring/backends');

export const getMonitoringSessions = (): Promise<MonitoringSessions> =>
  request<MonitoringSessions>('/api/v1/monitoring/sessions');

export const getMonitoringRuntime = (): Promise<MonitoringRuntime> =>
  request<MonitoringRuntime>('/api/v1/monitoring/runtime');

export const getDiagnostics = (): Promise<Diagnostics> => request<Diagnostics>('/api/v1/diagnostics');

export const getSettings = (): Promise<Settings> => request<Settings>('/api/v1/settings');

export interface ActivityQuery {
  page?: number;
  limit?: number;
  type?: string;
  outcome?: string;
  agentId?: string;
  backendId?: string;
  toolName?: string;
  search?: string;
  after?: string;
  before?: string;
  order?: 'asc' | 'desc';
}

export const getActivity = (query: ActivityQuery = {}): Promise<Page<ActivityEvent>> =>
  requestPage<ActivityEvent>('/api/v1/activity', { ...query });

export const getActivityEvent = (eventId: string): Promise<ActivityEvent> =>
  request<ActivityEvent>(`/api/v1/activity/${encodeURIComponent(eventId)}`);

export interface AuditQuery {
  page?: number;
  limit?: number;
  action?: string;
  actorType?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  result?: string;
  search?: string;
  after?: string;
  before?: string;
  order?: 'asc' | 'desc';
}

/** The list omits `metadata`; only the detail read renders it. */
export const getAudit = (query: AuditQuery = {}): Promise<Page<AuditEvent>> =>
  requestPage<AuditEvent>('/api/v1/audit', { ...query });

export const getAuditEvent = (eventId: string): Promise<AuditEvent> =>
  request<AuditEvent>(`/api/v1/audit/${encodeURIComponent(eventId)}`);
