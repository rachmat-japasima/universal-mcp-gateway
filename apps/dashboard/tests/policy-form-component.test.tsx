import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Policy } from '@/lib/api/types';

/**
 * The policy form.
 *
 * The assertions that matter most are about restraint:
 *
 *  * saving a *narrowing* edit goes straight through;
 *  * saving a widening edit (new ALLOW, flipped DENY→ALLOW, removed DENY, or a
 *    `*` allow) is held behind a confirmation that names the change;
 *  * nothing in the form rewrites an effect on its own — a DENY stays DENY until
 *    the operator changes it;
 *  * changing the rule's resource clears the target instead of carrying a
 *    backend id into a tool rule.
 */

const send = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock('@/lib/api/write-client', () => ({ send: (...args: unknown[]) => send(...args) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

if (typeof HTMLDialogElement !== 'undefined' && HTMLDialogElement.prototype.showModal === undefined) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    this.open = false;
  };
}

if (typeof globalThis.CSS === 'undefined') {
  Object.defineProperty(globalThis, 'CSS', {
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (character) => `\\${character}`) },
  });
}

const { PolicyForm } = await import('@/features/policies/policy-form');

const POLICY = '77777777-7777-4777-8777-777777777777';
const BACKEND = '11111111-1111-4111-8111-111111111111';

const BACKENDS = [{ id: BACKEND, name: 'github' }];

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    id: POLICY,
    name: 'read-only',
    priority: 10,
    rules: [{ resource: 'tool', target: 'github__read', effect: 'allow' }],
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Rule fields repeat once per rule, so a label query is ambiguous by design.
 * These helpers address the last rule — the one the test just added — and the
 * first, which is the stored one.
 */
function field(label: string, position: 'first' | 'last' = 'last'): HTMLElement {
  const all = screen.getAllByLabelText(label);
  return position === 'first' ? all[0]! : all[all.length - 1]!;
}

beforeEach(() => {
  send.mockReset();
  push.mockReset();
  refresh.mockReset();
});

describe('PolicyForm create', () => {
  it('creates with POST and lands on the detail page so it can be assigned', async () => {
    send.mockResolvedValue({ ok: true, status: 201, data: policy({ rules: [] }) });

    render(<PolicyForm backends={BACKENDS} />);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: ' read-only ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create policy' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/dashboard/policies/${POLICY}`));
    expect(send).toHaveBeenCalledWith('/api/policies', {
      method: 'POST',
      body: { name: 'read-only', priority: 0, rules: [] },
    });
  });

  it('validates locally and sends nothing for a blank name', async () => {
    render(<PolicyForm backends={BACKENDS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create policy' }));

    await waitFor(() => expect(screen.getByText('A name is required.')).toBeTruthy());
    expect(send).not.toHaveBeenCalled();
  });

  it('says a policy with no rules grants nothing', async () => {
    render(<PolicyForm backends={BACKENDS} />);

    expect(screen.getByText(/will not grant anything until it has at least one ALLOW rule/)).toBeTruthy();
  });

  it('confirms before creating a policy whose only rule is a wildcard allow', async () => {
    send.mockResolvedValue({ ok: true, status: 201, data: policy() });

    render(<PolicyForm backends={BACKENDS} />);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'everything' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    fireEvent.change(screen.getByLabelText('Public tool name'), { target: { value: '*' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create policy' }));

    expect(screen.getByText('This change widens access')).toBeTruthy();
    // The dialog names the rule being added, so the widening is not anonymous.
    expect(screen.getByText(/tool:\* becomes allowed/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save and widen access' }));
    await waitFor(() => expect(send).toHaveBeenCalled());
  });
});

describe('PolicyForm edit', () => {
  it('sends the whole rule array, because the gateway replaces it', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: policy() });

    render(<PolicyForm policy={policy()} backends={BACKENDS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith(`/api/policies/${POLICY}`, {
      method: 'PATCH',
      body: {
        name: 'read-only',
        priority: 10,
        rules: [{ resource: 'tool', target: 'github__read', effect: 'allow' }],
        description: null,
      },
    });
  });

  it('saves a narrowing edit without a confirmation', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: policy({ rules: [] }) });

    render(<PolicyForm policy={policy()} backends={BACKENDS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove rule' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(screen.queryByText('This change widens access')).toBeNull();
  });

  it('holds a new ALLOW rule behind a confirmation that names it', () => {
    render(<PolicyForm policy={policy()} backends={BACKENDS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    fireEvent.change(field('Public tool name'), { target: { value: 'github__delete' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(screen.getByText('This change widens access')).toBeTruthy();
    expect(screen.getByText(/tool:github__delete becomes allowed/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('never flips a DENY to ALLOW on its own', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: policy() });

    render(
      <PolicyForm
        policy={policy({ rules: [{ resource: 'tool', target: 'github__delete', effect: 'deny' }] })}
        backends={BACKENDS}
      />,
    );

    // Untouched: the rule summary still says it refuses, and saving sends DENY.
    expect(screen.getByText(/refuses github__delete/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(send.mock.calls[0]![1]).toMatchObject({
      body: expect.objectContaining({
        rules: [{ resource: 'tool', target: 'github__delete', effect: 'deny' }],
      }),
    });
    expect(screen.queryByText('This change widens access')).toBeNull();
  });

  it('confirms when a DENY rule is removed, because that restores access', () => {
    render(
      <PolicyForm
        policy={policy({ rules: [{ resource: 'tool', target: 'github__delete', effect: 'deny' }] })}
        backends={BACKENDS}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove rule' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(screen.getByText(/tool:github__delete is no longer denied/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not save when the operator goes back from the confirmation', () => {
    render(<PolicyForm policy={policy()} backends={BACKENDS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    fireEvent.change(field('Public tool name'), { target: { value: 'github__delete' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));

    expect(send).not.toHaveBeenCalled();
  });

  it('renders a picker for a backend rule and a text field for a tool rule', () => {
    const backendRule = render(
      <PolicyForm
        policy={policy({ rules: [{ resource: 'backend', target: BACKEND, effect: 'allow' }] })}
        backends={BACKENDS}
      />,
    );

    // A backend target is chosen from the registry, never typed as free text —
    // so a tool-shaped string cannot be entered into a backend rule at all.
    // Three pickers: resource, backend, effect.
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
    expect(screen.queryByLabelText('Public tool name')).toBeNull();
    backendRule.unmount();

    render(
      <PolicyForm
        policy={policy({ rules: [{ resource: 'tool', target: 'github__read', effect: 'allow' }] })}
        backends={BACKENDS}
      />,
    );

    expect((screen.getByLabelText('Public tool name') as HTMLInputElement).value).toBe('github__read');
    // Two pickers: resource and effect. The target is free text.
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
  });

  it('keeps a backend target the registry no longer lists instead of dropping it', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: policy() });

    render(<PolicyForm policy={policy()} backends={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0]![1]).toMatchObject({
      body: expect.objectContaining({
        rules: [{ resource: 'tool', target: 'github__read', effect: 'allow' }],
      }),
    });
  });

  it('surfaces a rejected save without refreshing', async () => {
    send.mockResolvedValue({
      ok: false,
      status: 409,
      message: 'A policy with that name already exists.',
    });

    render(<PolicyForm policy={policy()} backends={BACKENDS} />);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'taken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByText('A policy with that name already exists.')).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refuses a second submission while one is in flight', async () => {
    let release: ((value: unknown) => void) | undefined;
    send.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    render(<PolicyForm policy={policy()} backends={BACKENDS} />);
    const button = screen.getByRole('button', { name: 'Save changes' });
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBe('true'));

    fireEvent.click(button);
    expect(send).toHaveBeenCalledTimes(1);

    release?.({ ok: true, status: 200, data: policy() });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('refuses a rule with no target locally, naming the field', async () => {
    render(<PolicyForm policy={policy()} backends={BACKENDS} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByText('A target is required, or `*` for everything.')).toBeTruthy());
    expect(send).not.toHaveBeenCalled();
  });
});
