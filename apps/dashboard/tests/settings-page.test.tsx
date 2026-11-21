import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/errors';
import type { Settings } from '@/lib/api/types';

/**
 * The settings page.
 *
 * Claims pinned here:
 *
 *  * every value is labelled environment-managed, and no control can change one;
 *  * there is no generic key/value editor, and no dead form that posts nowhere;
 *  * `readOnly` and `settingsMutation: false` are shown *as* read-only rather than
 *    rendered as off switches that imply an editor;
 *  * a failed read is an error state, not a page of blanks.
 */

const getSettings = vi.fn();

vi.mock('@/lib/api/endpoints', () => ({ getSettings: () => getSettings() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/settings',
}));

const { default: SettingsPage } = await import('@/app/(dashboard)/dashboard/settings/page');

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    environment: 'production',
    host: '127.0.0.1',
    port: 8787,
    endpoints: { mcp: '/mcp', health: '/health', api: '/api/v1' },
    logging: { level: 'info' },
    limits: {
      requestBodyLimitBytes: 1_048_576,
      requestTimeoutMs: 30_000,
      toolDiscoveryTimeoutMs: 10_000,
      toolCallTimeoutMs: 60_000,
    },
    sessions: { idleTimeoutMs: 900_000, maxLifetimeMs: 3_600_000 },
    backendConnections: {
      reconnect: { enabled: true, initialDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5, jitterRatio: 0.2 },
      allowPrivateNetwork: false,
    },
    features: {
      authentication: true,
      sessions: true,
      toolRouting: true,
      backendLifecycle: true,
      auditTrail: true,
      settingsMutation: false,
      metrics: true,
    },
    readOnly: true,
    ...overrides,
  };
}

beforeEach(() => {
  getSettings.mockReset();
  getSettings.mockResolvedValue(settings());
});

async function renderPage(): Promise<void> {
  render(await SettingsPage());
}

describe('settings page', () => {
  it('renders the effective configuration', async () => {
    await renderPage();

    expect(screen.getByText('127.0.0.1')).toBeTruthy();
    expect(screen.getByText('8787')).toBeTruthy();
    expect(screen.getByText('production')).toBeTruthy();
    expect(screen.getByText('/mcp')).toBeTruthy();
    expect(screen.getByText('1,048,576 bytes')).toBeTruthy();
  });

  it('offers no form control at all', async () => {
    const { container } = render(await SettingsPage());

    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector('button[type="submit"]')).toBeNull();
  });

  it('labels the values as read-only and environment-managed', async () => {
    await renderPage();

    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(screen.getAllByText(/Environment-managed/).length).toBeGreaterThan(0);
    expect(screen.getByText(/edit the gateway’s environment, restart it/)).toBeTruthy();
  });

  it('reports settings mutation as unavailable instead of an off switch', async () => {
    await renderPage();

    expect(screen.getByText('Settings mutation')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('reports metrics as available, with the reset-on-restart caveat', async () => {
    await renderPage();

    expect(screen.getByText('Metrics')).toBeTruthy();
    expect(screen.getByText(/In-memory counters and histograms/)).toBeTruthy();
    expect(screen.getByText(/reset on restart/i)).toBeTruthy();
  });

  it('explains the operator account procedure rather than faking a password form', async () => {
    await renderPage();

    expect(screen.getByText('Operator account')).toBeTruthy();
    expect(screen.getByText(/no password-change API/i)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('treats a failed read as an error, not as an empty configuration', async () => {
    getSettings.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getByText('The settings could not be read')).toBeTruthy();
    expect(screen.queryByText('127.0.0.1')).toBeNull();
  });
});
