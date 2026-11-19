'use client';

import { Button } from '@astryxdesign/core/Button';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/**
 * Re-reads the server component tree.
 *
 * The dashboard has no client-side cache to invalidate, so a refresh is simply a
 * new server render — the same path the first paint took, which keeps one code
 * path for "how this page gets data".
 */
export function RefreshButton({ label = 'Refresh' }: { label?: string }): React.ReactElement {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      label={label}
      variant="secondary"
      size="sm"
      isLoading={isPending}
      onClick={() => startTransition(() => router.refresh())}
    />
  );
}
