'use client';

import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useState } from 'react';

import type { LoginFailure } from '@/lib/auth/login';

/**
 * The sign-in form.
 *
 * A client component for exactly one reason: the failure has to be reported
 * without losing what was typed, and the submit needs a pending state. It does
 * not authenticate anything — it posts to `/api/login`, a server route that
 * forwards the credentials to the gateway over loopback. Nothing in this file
 * can decide that a login succeeded, which is the property that keeps the
 * dashboard from ever becoming the guard.
 *
 * Accessibility choices that are not optional here:
 *   * both fields carry visible labels (Astryx always renders them);
 *   * the error is a live region, so a screen reader announces a rejected
 *     sign-in instead of leaving the focus on a button that did nothing;
 *   * the reveal toggle is a real button with an accessible name that changes
 *     with state, and the input keeps its label association;
 *   * `autoComplete` is set so a password manager can fill both fields.
 */

export interface LoginFormProps {
  /** Where to go after a successful sign-in. Already validated by the route. */
  next: string;
}

type SubmitState = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'failed'; failure: LoginFailure };

export function LoginForm({ next }: LoginFormProps): React.ReactElement {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isPasswordVisible, setPasswordVisible] = useState(false);
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });

  const isSubmitting = state.kind === 'submitting';
  const failure = state.kind === 'failed' ? state.failure : undefined;

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setState({ kind: 'submitting' });

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, next }),
        // The redirect is followed by the browser, not by `fetch`: the server
        // answers 200 with the destination so the cookie is already set.
        redirect: 'error',
      });

      const body = (await response.json()) as { data?: { next?: string }; error?: LoginFailure };

      if (!response.ok || body.data?.next === undefined) {
        setState({
          kind: 'failed',
          failure: body.error ?? {
            message: 'The gateway did not accept the sign-in request.',
            reason: 'unexpected_response',
          },
        });
        return;
      }

      // A full navigation, not `router.push`: the session cookie was just set by
      // this response and the protected tree must be rendered by a request that
      // carries it.
      window.location.assign(body.data.next);
    } catch {
      setState({
        kind: 'failed',
        failure: {
          message: 'Cannot reach the gateway. Check that it is running, then retry.',
          reason: 'gateway_unreachable',
        },
      });
    }
  }

  return (
    <Card padding={4}>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <VStack gap={4}>
          <VStack gap={1}>
            <Text type="label" as="h1">
              Sign in
            </Text>
            <Text type="supporting" as="p">
              Operator credentials are verified by the gateway, not by this dashboard.
            </Text>
          </VStack>

          {failure === undefined ? null : (
            <div role="alert" aria-live="assertive" data-testid="login-error">
              <Text type="supporting" as="p">
                {failure.message}
              </Text>
            </div>
          )}

          <TextInput
            label="Username"
            value={username}
            onChange={setUsername}
            autoComplete="username"
            isRequired
            isDisabled={isSubmitting}
            hasAutoFocus
          />

          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextInput
                label="Password"
                type={isPasswordVisible ? 'text' : 'password'}
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                isRequired
                isDisabled={isSubmitting}
                hasAutoCorrect={false}
                hasSpellCheck={false}
              />
            </div>
            <IconButton
              // The name states the *action*, so a screen reader announces what
              // pressing it does rather than repeating the current state.
              label={isPasswordVisible ? 'Hide password' : 'Show password'}
              icon={isPasswordVisible ? <EyeOffIcon /> : <EyeIcon />}
              variant="ghost"
              size="sm"
              isDisabled={isSubmitting}
              onClick={() => setPasswordVisible((visible) => !visible)}
            />
          </div>

          <Button type="submit" label="Sign in" variant="primary" isLoading={isSubmitting} isDisabled={isSubmitting} />
        </VStack>
      </form>
    </Card>
  );
}

/** Inline SVGs, so the form adds no icon dependency for two glyphs. */

function EyeIcon(): React.ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function EyeOffIcon(): React.ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1 8s2.5-4.5 7-4.5c1.2 0 2.3.35 3.2.87M15 8s-2.5 4.5-7 4.5c-1.2 0-2.3-.35-3.2-.87" />
      <path d="M2 2l12 12" />
    </svg>
  );
}
