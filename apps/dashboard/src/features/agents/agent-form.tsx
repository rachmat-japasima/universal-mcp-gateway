'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { Agent, AgentCreateInput, AgentUpdateInput, ClientType } from '@/lib/api/types';
import { CLIENT_TYPES } from '@/lib/api/types';
import { send } from '@/lib/api/write-client';

/**
 * Create and edit, one component.
 *
 * The two flows differ only in where the payload goes: `POST /api/v1/agents`
 * (create) or `PATCH /api/v1/agents/:id` (edit). There is no `version` field on
 * an agent, so there is no compare-and-set to promise: a concurrent edit is
 * last-writer-wins at the API, and the page re-reads afterwards rather than
 * pretending it detected a conflict.
 *
 * Deliberate properties:
 *
 *  * **No credential is created here.** An agent profile and a credential are
 *    separate decisions; mixing them would make "create agent" quietly mint a
 *    long-lived secret, and the token would appear in a form flow that has no
 *    room to display it once. Credentials have their own panel.
 *  * **`metadata` is not editable yet.** It is a free-form map with reserved-key
 *    rules; a JSON textarea would be a worse editor than nothing, so the form
 *    leaves it alone rather than risking a silent overwrite on edit.
 *  * **Nothing is reported successful before the gateway answers.**
 */

const CLIENT_OPTIONS = [
  { value: '', label: 'Not set' },
  ...CLIENT_TYPES.map((type) => ({ value: type, label: type })),
];

type Pending = 'save' | null;

interface FormState {
  name: string;
  description: string;
  clientType: string;
  enabled: boolean;
}

function formFromAgent(agent: Agent): FormState {
  return {
    name: agent.name,
    description: agent.description ?? '',
    clientType: agent.clientType ?? '',
    enabled: agent.enabled,
  };
}

const EMPTY_FORM: FormState = { name: '', description: '', clientType: '', enabled: true };

export function AgentForm({ agent }: { agent?: Agent }): React.ReactElement {
  const router = useRouter();
  const isEdit = agent !== undefined;

  const [form, setForm] = useState<FormState>(() => (agent === undefined ? EMPTY_FORM : formFromAgent(agent)));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ status: 'error' | 'success'; text: string } | undefined>(undefined);
  const [pending, setPending] = useState<Pending>(null);

  const busy = pending !== null;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  function clearError(field: string): void {
    setErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function validate(): boolean {
    const found: Record<string, string> = {};
    const name = form.name.trim();

    if (name === '') found.name = 'A name is required.';
    else if (name.length > 120) found.name = 'At most 120 characters.';
    if (form.description.trim().length > 2000) found.description = 'At most 2000 characters.';

    setErrors(found);
    return Object.keys(found).length === 0;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;

    setBanner(undefined);
    if (!validate()) {
      setBanner({ status: 'error', text: 'Fix the highlighted fields, then save again.' });
      return;
    }

    const description = form.description.trim();
    const clientType = form.clientType as ClientType | '';

    setPending('save');

    if (!isEdit) {
      const input: AgentCreateInput = {
        name: form.name.trim(),
        enabled: form.enabled,
        ...(description === '' ? {} : { description }),
        ...(clientType === '' ? {} : { clientType }),
      };

      const result = await send<Agent>('/api/agents', { method: 'POST', body: input });
      setPending(null);

      if (!result.ok) {
        setBanner({ status: 'error', text: result.message ?? 'The agent could not be created.' });
        return;
      }

      if (result.data?.id === undefined) {
        setBanner({ status: 'error', text: 'The agent was created but the response could not be read. Open the list to find it.' });
        router.push('/dashboard/agents');
        return;
      }

      // Straight to the detail page, where a credential can be issued. A created
      // agent with no credential cannot authenticate, and saying so is the next
      // screen's job.
      router.push(`/dashboard/agents/${result.data.id}`);
      return;
    }

    // `undefined` keeps a field, `null` clears it. Sending `''` would store an
    // empty description instead of the absence the API distinguishes.
    const input: AgentUpdateInput = {
      name: form.name.trim(),
      enabled: form.enabled,
      description: description === '' ? null : description,
      clientType: clientType === '' ? null : clientType,
    };

    const result = await send<Agent>(`/api/agents/${agent.id}`, { method: 'PATCH', body: input });
    setPending(null);

    if (!result.ok) {
      setBanner({ status: 'error', text: result.message ?? 'The agent could not be saved.' });
      return;
    }

    setBanner({ status: 'success', text: 'Saved.' });
    router.refresh();
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
            <TextInput
              label="Name"
              value={form.name}
              isRequired
              description="Unique in the registry. At most 120 characters."
              status={errors.name === undefined ? undefined : { type: 'error', message: errors.name }}
              onChange={(value) => {
                clearError('name');
                set('name', value);
              }}
            />

            <TextArea
              label="Description"
              value={form.description}
              rows={3}
              description="Optional. What this agent is for, and who runs it."
              status={errors.description === undefined ? undefined : { type: 'error', message: errors.description }}
              onChange={(value) => {
                clearError('description');
                set('description', value);
              }}
            />

            <Selector
              label="Client type"
              value={form.clientType}
              options={CLIENT_OPTIONS}
              description="Display metadata only. It does not affect authorization."
              onChange={(value) => set('clientType', value)}
            />

            <Switch
              label="Enabled"
              value={form.enabled}
              description="A disabled agent cannot start a session, and its live sessions are invalidated when it is disabled."
              onChange={(checked) => set('enabled', checked)}
            />

            {isEdit ? (
              <Text type="supporting" as="p">
                Saving does not change credentials. Disabling here does, so prefer the Disable action on the detail page
                where the consequence is stated before you confirm.
              </Text>
            ) : null}
          </VStack>
        </Card>

        <HStack gap={2} wrap="wrap">
          <Button
            label={isEdit ? 'Save changes' : 'Create agent'}
            type="submit"
            variant="primary"
            isLoading={pending === 'save'}
            isDisabled={busy}
          />
          <Button
            label="Cancel"
            href={isEdit ? `/dashboard/agents/${agent.id}` : '/dashboard/agents'}
            variant="ghost"
          />
        </HStack>
      </VStack>
    </form>
  );
}
