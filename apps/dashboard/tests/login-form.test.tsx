import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LoginForm } from '@/features/auth/login-form';

/**
 * The sign-in form.
 *
 * These tests pin the behaviours a broken login would exhibit silently:
 *
 *   * the password field must actually be masked, and the reveal control must
 *     change the field type rather than merely change an icon;
 *   * a rejected sign-in must keep what was typed (the operator should not have
 *     to retype a username), report it in a live region, and not navigate;
 *   * only a 2xx with a destination may navigate, and it must be a full page
 *     load so the newly set cookie is sent with the next request.
 *
 * `window.location.assign` is replaced with a spy: jsdom's location is not
 * writable, and asserting "did not navigate" is the point of half these cases.
 */

const assign = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/login',
}));

function mockFetch(implementation: () => Promise<Response> | Response): ReturnType<typeof vi.fn> {
  const spy = vi.fn(implementation);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  assign.mockReset();
  vi.stubGlobal('location', { assign });
});

function renderForm(next = '/dashboard'): void {
  render(<LoginForm next={next} />);
}

/**
 * The two fields, found by their labels.
 *
 * Astryx appends an `aria-hidden` required marker to the label's text
 * (`Username ∙`), so an exact match finds nothing. The regexes anchor on the
 * visible word: changing them to `exact: false` would also match a future
 * "Username (optional)" field, which is a different control.
 */
const usernameField = (): HTMLInputElement => screen.getByLabelText(/^Username/);
const passwordField = (): HTMLInputElement => screen.getByLabelText(/^Password/);

/** Types into the two labeled fields. Labels come from Astryx, not from us. */
function fill(username: string, password: string): void {
  fireEvent.change(usernameField(), { target: { value: username } });
  fireEvent.change(passwordField(), { target: { value: password } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginForm', () => {
  it('renders labeled fields and a masked password by default', () => {
    renderForm();

    expect(usernameField()).toBeDefined();

    const password = passwordField() as HTMLInputElement;
    expect(password.type).toBe('password');
    expect(password.autocomplete).toBe('current-password');
    expect((usernameField() as HTMLInputElement).autocomplete).toBe('username');
  });

  it('toggles password visibility with an accessible, state-named button', () => {
    renderForm();

    const toggle = screen.getByRole('button', { name: 'Show password' });
    fireEvent.click(toggle);

    expect((passwordField() as HTMLInputElement).type).toBe('text');
    // The name states the action, so it changes with the state.
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect((passwordField() as HTMLInputElement).type).toBe('password');
  });

  it('posts credentials to the dashboard route, never to the gateway', async () => {
    const fetchSpy = mockFetch(() => jsonResponse({ data: { next: '/dashboard/audit' } }));
    renderForm('/dashboard/audit');

    fill('operator', 'a-long-password');
    submit();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/login');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      username: 'operator',
      password: 'a-long-password',
      next: '/dashboard/audit',
    });
  });

  it('shows the gateway message, keeps the input, and does not navigate on refusal', async () => {
    mockFetch(() =>
      jsonResponse({ error: { message: 'The username or password is incorrect.', reason: 'invalid_credentials' } }, 401),
    );
    renderForm();

    fill('operator', 'wrong-password');
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The username or password is incorrect.');
    expect((usernameField() as HTMLInputElement).value).toBe('operator');
    expect(assign).not.toHaveBeenCalled();
    // The button is usable again, so a retry does not need a reload.
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('reports an unreachable gateway as a connection problem, not bad credentials', async () => {
    mockFetch(() => Promise.reject(new TypeError('fetch failed')));
    renderForm();

    fill('operator', 'a-long-password');
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Cannot reach the gateway');
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not navigate on a success that carries no destination', async () => {
    mockFetch(() => jsonResponse({ data: {} }));
    renderForm();

    fill('operator', 'a-long-password');
    submit();

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(assign).not.toHaveBeenCalled();
  });

  it('navigates to the returned destination after a successful sign-in', async () => {
    mockFetch(() => jsonResponse({ data: { next: '/dashboard/backends' } }));
    renderForm('/dashboard/backends');

    fill('operator', 'a-long-password');
    submit();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/dashboard/backends'));
  });

  it('cannot be submitted twice while in flight', async () => {
    let release: ((response: Response) => void) | undefined;
    const fetchSpy = mockFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    renderForm();

    fill('operator', 'a-long-password');
    submit();
    submit();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    release?.(jsonResponse({ data: { next: '/dashboard' } }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
  });
});
