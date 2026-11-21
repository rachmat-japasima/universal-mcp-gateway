'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { VStack } from '@astryxdesign/core/VStack';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ToolRefreshResult } from '@/lib/api/types';
import { send } from '@/lib/api/write-client';

/**
 * Re-runs discovery and then re-reads the page.
 *
 * The whole catalog or one backend — the two routes the gateway actually has.
 * Global discovery reports failures per backend in a `200` body, so "the request
 * succeeded" and "every backend refreshed" are different claims and the summary
 * says which happened.
 *
 * Refreshing dials every backend, so it is not free and not instant. The button
 * is disabled while a run is in flight rather than merely styled as busy, and
 * the result is only announced after the gateway has answered.
 */

type Outcome = { tone: 'success' | 'warning'; message: string; failures: Array<{ label: string; message: string }> };

function describeGlobal(result: ToolRefreshResult): Outcome {
  const failures = result.results
    .filter((entry) => !entry.ok)
    .map((entry) => ({ label: entry.backendId, message: entry.error?.message ?? 'No reason reported.' }));

  if (result.failed === 0) {
    return {
      tone: 'success',
      message: `Refreshed ${result.refreshed} backend${result.refreshed === 1 ? '' : 's'}.`,
      failures: [],
    };
  }

  return {
    tone: 'warning',
    message: `Refreshed ${result.refreshed}, failed ${result.failed}. The catalog keeps the last successful snapshot for a backend that failed.`,
    failures,
  };
}

export function ToolRefresh({
  backendId,
  label = 'Refresh catalog',
}: {
  /** Omit to refresh every eligible backend. */
  backendId?: string;
  label?: string;
}): React.ReactElement {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);

  async function run(): Promise<void> {
    if (pending) return;
    setPending(true);
    setOutcome(undefined);

    const result = await send<ToolRefreshResult>(
      backendId === undefined ? '/api/tools/refresh' : `/api/backends/${backendId}/tools/refresh`,
      { method: 'POST' },
    );

    setPending(false);

    if (!result.ok) {
      setOutcome({ tone: 'warning', message: result.message ?? 'The refresh failed.', failures: [] });
      return;
    }

    if (backendId !== undefined) {
      const report = (result.data as { discovery?: { toolCount?: number } } | undefined)?.discovery;      setOutcome({
        tone: 'success',
        message:
          report?.toolCount === undefined
            ? 'Discovery completed.'
            : `Discovery completed · ${report.toolCount} tool${report.toolCount === 1 ? '' : 's'}.`,
        failures: [],
      });
    } else if (result.data === undefined) {
      setOutcome({ tone: 'warning', message: 'The refresh answer could not be read.', failures: [] });
      return;
    } else {
      setOutcome(describeGlobal(result.data));
    }

    // The newly discovered catalog is the server render's job, not a client guess.
    router.refresh();
  }

  return (
    <VStack gap={2}>
      <Button
        label={pending ? 'Refreshing…' : label}
        variant="secondary"
        isLoading={pending}
        // `isDisabled` only sets `aria-disabled`; the `pending` guard above is
        // what actually stops a second submission.
        isDisabled={pending}
        onClick={() => void run()}
      />

      {outcome === undefined ? null : (
        <Banner
          status={outcome.tone}
          title={outcome.message}
          // Failures are the reason this banner exists, so the detail must not
          // start behind an expand control.
          {...(outcome.failures.length === 0 ? {} : { collapsible: { defaultIsOpen: true } })}
        >
          {outcome.failures.length === 0 ? undefined : (
            <VStack gap={1}>
              {outcome.failures.map((failure) => (
                <span key={failure.label}>
                  {failure.label}: {failure.message}
                </span>
              ))}
            </VStack>
          )}
        </Banner>
      )}
    </VStack>
  );
}
