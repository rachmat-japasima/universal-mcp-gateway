import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Backend, Tool } from '@/lib/api/types';
import { ApiError } from '@/lib/api/errors';

/**
 * Tool detail.
 *
 * The security-relevant claim is here, not in the layout: a backend supplies
 * `inputSchema`, and this page must present it as inert text. Astryx `CodeBlock`
 * renders a `<pre>` from a string, so the assertions below check that the schema
 * text is present as text and that nothing constructed a live element from it.
 */

const getTool = vi.fn();
const getBackend = vi.fn();
const notFound = vi.fn();

vi.mock('next/navigation', () => ({
  notFound: () => notFound(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/api/tools', () => ({
  getTool: (...args: unknown[]) => getTool(...args),
  listTools: vi.fn(),
  getDiscoveryReports: vi.fn(),
  getToolConflicts: vi.fn(),
}));
vi.mock('@/lib/api/backends', () => ({ getBackend: (...args: unknown[]) => getBackend(...args) }));

const { default: ToolPage } = await import('@/app/(dashboard)/dashboard/tools/[toolId]/page');

const BACKEND = '11111111-1111-4111-8111-111111111111';
const NAME = `${BACKEND}__read_file`;

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    publicName: NAME,
    originalName: 'read_file',
    backendId: BACKEND,
    title: 'Read File',
    description: 'Read one file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    availability: 'available',
    discoveredAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T01:00:00.000Z',
    ...overrides,
  };
}

const backend: Backend = {
  id: BACKEND,
  name: 'filesystem',
  transport: 'stdio',
  connection: { type: 'stdio', command: 'npx', args: [], env: {} },
  enabled: true,
  timeoutMs: 30000,
  concurrencyMode: 'serialized',
  version: 1,
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
};

async function renderPage(toolId = NAME): Promise<void> {
  render(await ToolPage({ params: Promise.resolve({ toolId }) }));
}

beforeEach(() => {
  getTool.mockReset();
  getBackend.mockReset();
  notFound.mockReset();
  getBackend.mockResolvedValue(backend);
});

describe('tool detail page', () => {
  it('shows identity, availability, and the owning backend link', async () => {
    getTool.mockResolvedValue(tool());

    await renderPage();

    expect(screen.getAllByText('Read File').length).toBeGreaterThan(0);
    expect(screen.getByText(NAME)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'filesystem' }).getAttribute('href')).toBe(`/dashboard/backends/${BACKEND}`);
    expect(screen.getAllByText('Available').length).toBeGreaterThan(0);
  });

  it('decodes the public name from the URL before reading', async () => {
    getTool.mockResolvedValue(tool());

    await renderPage(encodeURIComponent(NAME));

    expect(getTool).toHaveBeenCalledWith(NAME);
  });

  it('renders the input schema as inert text, never as markup', async () => {
    getTool.mockResolvedValue(
      tool({
        inputSchema: {
          type: 'object',
          description: '<img src=x onerror="window.__pwned=1">',
          properties: { path: { type: 'string' } },
        },
      }),
    );

    const { container } = render(await ToolPage({ params: Promise.resolve({ toolId: NAME }) }));

    const text = container.textContent ?? '';
    expect(text).toContain('onerror');
    // The payload survives as characters in a <pre>, and no element was built
    // from it.
    expect(container.querySelector('img')).toBeNull();
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('explains why a conflicting tool is not routed, and keeps its schema visible', async () => {
    getTool.mockResolvedValue(tool({ availability: 'conflict', unavailableReason: 'Two backends claim this name.' }));

    await renderPage();

    expect(screen.getAllByText('Name conflict').length).toBeGreaterThan(0);
    expect(screen.getByText('Two backends claim this name.')).toBeTruthy();
    expect(screen.getByText(/withholds every claimant/)).toBeTruthy();
    expect(screen.getByText(/properties/)).toBeTruthy();
  });

  it('says the backend is disabled and that no policy can override it', async () => {
    getTool.mockResolvedValue(tool());
    getBackend.mockResolvedValue({ ...backend, enabled: false });

    await renderPage();

    expect(screen.getByText(/system restriction the policy engine applies/)).toBeTruthy();
  });

  it('calls notFound for a 404 rather than rendering an empty page', async () => {
    getTool.mockRejectedValue(new ApiError('http', 'The requested tool does not exist.', { status: 404 }));

    await renderPage('missing__tool');

    expect(notFound).toHaveBeenCalled();
  });

  it('renders an error state for a non-404 failure', async () => {
    getTool.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getByText('This tool could not be read')).toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

  it('states plainly that there is no dashboard invocation console', async () => {
    getTool.mockResolvedValue(tool());

    await renderPage();

    expect(screen.getByText(/There is no REST invocation route/)).toBeTruthy();
    // No control could trigger a call, because there is no endpoint behind one.
    expect(screen.queryByRole('button', { name: /run|invoke|call tool/i })).toBeNull();
  });

  it('renders optional schemas only when the backend supplied them', async () => {
    getTool.mockResolvedValue(tool());
    const first = render(await ToolPage({ params: Promise.resolve({ toolId: NAME }) }));
    expect(first.queryByText('Output schema')).toBeNull();
    first.unmount();

    getTool.mockResolvedValue(tool({ outputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }));
    const second = render(await ToolPage({ params: Promise.resolve({ toolId: NAME }) }));
    expect(second.getByText('Output schema')).toBeTruthy();
    expect(second.getByText('Annotations')).toBeTruthy();
  });
});
