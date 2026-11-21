'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { IntegrationConnection, IntegrationProvider } from '@/lib/api/types';
import { send } from '@/lib/api/write-client';

/**
 * Create a connection. The screen that does NOT take a token.
 *
 * The create route accepts `providerId` and `name` only; the token has its own
 * write-only step on the detail page, and no paste target here could leak it
 * into a connection row that has not been created yet. `metadata` exists on the
 * route but no registered provider needs it, so the form does not offer a field
 * the gateway would store verbatim.
 */

interface FormState {
  providerId: string;
  name: string;
}

/**
 * A registry with exactly one provider (today's: GitHub) has an obvious
 * default, so it starts selected; the operator can still change it. With two
 * or more, no default would be honest, so the field starts empty and
 * validation asks.
 */
function initialState(providers: IntegrationProvider[]): FormState {
  return { providerId: providers.length === 1 ? providers[0]!.id : '', name: '' };
}

export function ConnectionForm({ providers }: { providers: IntegrationProvider[] }): React.ReactElement {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(() => initialState(providers));
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [banner, setBanner] = useState<{ status: 'error'; text: string } | undefined>(undefined);
  const [pending, setPending] = useState(false);

  const busy = pending;
  const options = providers.map((provider) => ({ value: provider.id, label: provider.name }));

  function validate(): boolean {
    const found: Partial<Record<keyof FormState, string>> = {};
    if (form.providerId === '') found.providerId = 'Choose a provider.';
    if (form.name.trim() === '') found.name = 'A name is required.';
    else if (form.name.trim().length > 100) found.name = 'At most 100 characters.';

    setErrors(found);
    return Object.keys(found).length === 0;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;

    setBanner(undefined);
    if (!validate()) {
      setBanner({ status: 'error', text: 'Fix the highlighted fields, then try again.' });
      return;
    }

    setPending(true);

    const result = await send<IntegrationConnection>('/api/integrations/connections', {
      method: 'POST',
      body: { providerId: form.providerId, name: form.name.trim() },
    });
    setPending(false);

    if (!result.ok) {
      setBanner({ status: 'error', text: result.message ?? 'The connection could not be created.' });
      return;
    }

    if (result.data?.id === undefined) {
      setBanner({ status: 'error', text: 'The connection was created but the response could not be read. Open the list to find it.' });
      router.push('/dashboard/integrations');
      return;
    }

    // Straight to the detail page, where the token is stored and tested. A
    // created connection is `pending`: it exists, nothing is verified, nothing
    // is callable — and the next screen says so.
    router.push(`/dashboard/integrations/${result.data.id}`);
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate>
      <VStack gap={4}>
        {banner === undefined ? null : (
          <div role="status" aria-live="polite">
            <Banner status={banner.status} title={banner.text} />
          </div>
        )}

        <Card padding={4}>
          <VStack gap={3}>
            <Selector
              label="Provider"
              value={form.providerId}
              options={options}
              isRequired
              description="Code-registered providers only. There is no marketplace and no way to add one from this screen."
              status={errors.providerId === undefined ? undefined : { type: 'error', message: errors.providerId }}
              onChange={(value) => {
                setErrors((current) => ({ ...current, providerId: undefined }));
                setForm((current) => ({ ...current, providerId: value }));
              }}
            />

            <TextInput
              label="Name"
              value={form.name}
              isRequired
              description="Shown in lists and audit entries. At most 100 characters."
              status={errors.name === undefined ? undefined : { type: 'error', message: errors.name }}
              onChange={(value) => {
                setErrors((current) => ({ ...current, name: undefined }));
                setForm((current) => ({ ...current, name: value }));
              }}
            />
          </VStack>
        </Card>

        <HStack gap={2} wrap="wrap">
          <Button label="Create connection" type="submit" variant="primary" isLoading={pending} isDisabled={busy} />
          <Button label="Cancel" href="/dashboard/integrations" variant="ghost" />
        </HStack>
      </VStack>
    </form>
  );
}
