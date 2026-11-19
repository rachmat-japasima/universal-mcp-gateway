'use client';

import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { useState } from 'react';

/**
 * Operator identity and sign-out in the header.
 *
 * The username shown here came from the gateway's session probe on the server,
 * so it is a real identity rather than a claim the browser made. Sign-out posts
 * to the dashboard's own route, which revokes the session at the gateway before
 * clearing the cookie here; the button only navigates afterwards.
 *
 * A full navigation (`window.location.assign`) rather than `router.push`: the
 * cookie was just deleted by that response, and every server render after it
 * must be produced by a request that no longer carries one.
 */
export function AccountMenu({ username, role }: { username: string; role: string }): React.ReactElement {
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function signOut(): Promise<void> {
    setPending(true);
    setError(undefined);

    try {
      const response = await fetch('/api/logout', { method: 'POST', redirect: 'error' });
      if (!response.ok) throw new Error('logout failed');
      window.location.assign('/login');
    } catch {
      setPending(false);
      // The cookie was not cleared, so saying "signed out" would be a lie.
      setError('Sign-out failed. Try again.');
    }
  }

  return (
    <HStack gap={2} align="center">
      <Tooltip content={`Signed in as ${username} (${role})`}>
        <span className="inline-flex max-w-[12rem] truncate">
          <Text type="supporting" as="span" data-testid="operator-username">
            {username}
          </Text>
        </span>
      </Tooltip>
      {error === undefined ? null : (
        <Text type="supporting" as="span" role="alert">
          {error}
        </Text>
      )}
      <Button
        label="Sign out"
        size="sm"
        variant="ghost"
        isLoading={isPending}
        isDisabled={isPending}
        onClick={() => void signOut()}
      />
    </HStack>
  );
}
