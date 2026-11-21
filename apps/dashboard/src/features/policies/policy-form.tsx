'use client';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { Policy, PolicyEffect, PolicyResource, PolicyRule } from '@/lib/api/types';
import { POLICY_EFFECTS, POLICY_RESOURCES } from '@/lib/api/types';
import { send } from '@/lib/api/write-client';
import {
  EMPTY_FORM,
  EMPTY_RULE,
  broadeningChanges,
  formFromPolicy,
  hasWildcardAllow,
  toCreateInput,
  toUpdateInput,
  validateForm,
  WILDCARD,
  type PolicyFormState,
  type RuleDraft,
} from '@/lib/policies/form';

import { EffectBadge } from './policy-status';

/**
 * Policy create and edit, one component.
 *
 * The rule list is the whole policy: the gateway replaces `rules` wholesale on
 * `PATCH`, so the form always sends the full array and never adds a rule through
 * a second request. Rules cannot be edited on their own, and deleting one is a
 * real removal, not a flag.
 *
 * Two properties that are security requirements rather than polish:
 *
 *  * **The effect is never changed for the operator.** Switching a rule from
 *    DENY to ALLOW is a widening, and it must be a deliberate act. Nothing in
 *    this form rewrites an effect, reorders priority, or merges rules.
 *  * **A widening edit is confirmed first.** Before saving, the draft is diffed
 *    against what the gateway currently stores; every new ALLOW rule and every
 *    removed DENY is listed in a dialog. A `*` allow — the broadest grant the
 *    model can express — is called out by name.
 *
 * Effective access is *not* previewed here. That question belongs to an agent
 * (`GET /agents/:id/access`, the gateway's own evaluator) and is shown on the
 * agent page; recomputing rules in a browser would be a second, unauthorized
 * answer to the same question.
 */

const RESOURCE_OPTIONS = POLICY_RESOURCES.map((resource) => ({
  value: resource,
  label: resource === 'backend' ? 'Backend' : 'Tool',
}));

const EFFECT_OPTIONS = POLICY_EFFECTS.map((effect) => ({
  value: effect,
  label: effect === 'allow' ? 'ALLOW' : 'DENY',
}));

type Pending = 'save' | null;

function issueKey(index: number, field: string): string {
  return `rule-${index}-${field}`;
}

export function PolicyForm({
  policy,
  backends,
}: {
  policy?: Policy;
  /** Backends the registry knows, for the `backend` target picker. */
  backends: Array<{ id: string; name: string }>;
}): React.ReactElement {
  const router = useRouter();
  const isEdit = policy !== undefined;

  const [form, setForm] = useState<PolicyFormState>(() => (policy === undefined ? EMPTY_FORM : formFromPolicy(policy)));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ status: 'error' | 'success'; text: string } | undefined>(undefined);
  const [pending, setPending] = useState<Pending>(null);
  const [widenings, setWidenings] = useState<string[] | undefined>(undefined);

  const busy = pending !== null;

  const set = <K extends keyof PolicyFormState>(key: K, value: PolicyFormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  function clearError(key: string): void {
    setErrors((current) => {
      if (current[key] === undefined) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function updateRule(index: number, patch: Partial<RuleDraft>): void {
    setForm((current) => ({
      ...current,
      rules: current.rules.map((rule, position) => (position === index ? { ...rule, ...patch } : rule)),
    }));
    clearError(issueKey(index, 'target'));
  }

  /**
   * Changing the resource invalidates the target: a backend id is never a valid
   * tool name and vice versa. The field is cleared visibly rather than carried
   * across, so a rule cannot be saved naming something it does not mean.
   */
  function changeResource(index: number, resource: PolicyResource): void {
    updateRule(index, { resource, target: '' });
  }

  function addRule(): void {
    setForm((current) => ({ ...current, rules: [...current.rules, { ...EMPTY_RULE }] }));
  }

  function removeRule(index: number): void {
    setForm((current) => ({ ...current, rules: current.rules.filter((_, position) => position !== index) }));
  }

  /** The gateway's current rules, for the widening diff. Empty for a new policy. */
  function storedRules(): PolicyRule[] {
    return policy?.rules ?? [];
  }

  function requestSave(): void {
    setBanner(undefined);
    const found = validateForm(form);
    setErrors(found);

    if (Object.keys(found).length > 0) {
      setBanner({ status: 'error', text: 'Fix the highlighted fields, then save again.' });
      return;
    }

    const changes = broadeningChanges(storedRules(), form.rules);
    if (changes.length > 0 || hasWildcardAllow(form.rules)) {
      setWidenings(changes.length > 0 ? changes : ['This policy grants * (everything) to every agent it is assigned to.']);
      return;
    }

    void save();
  }

  async function save(): Promise<void> {
    if (busy) return;
    setPending('save');
    setWidenings(undefined);

    if (!isEdit) {
      const result = await send<Policy>('/api/policies', { method: 'POST', body: toCreateInput(form) });
      setPending(null);

      if (!result.ok) {
        setBanner({ status: 'error', text: result.message ?? 'The policy could not be created.' });
        return;
      }

      if (result.data?.id === undefined) {
        setBanner({ status: 'error', text: 'The policy was created but the response could not be read. Open the list to find it.' });
        router.push('/dashboard/policies');
        return;
      }

      // The detail page is where assignments happen; landing on the list would
      // leave a policy that grants nothing and look like a failure.
      router.push(`/dashboard/policies/${result.data.id}`);
      return;
    }

    const result = await send<Policy>(`/api/policies/${policy.id}`, { method: 'PATCH', body: toUpdateInput(form) });
    setPending(null);

    if (!result.ok) {
      setBanner({ status: 'error', text: result.message ?? 'The policy could not be saved.' });
      return;
    }

    setBanner({ status: 'success', text: 'Saved.' });
    router.refresh();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        requestSave();
      }}
      noValidate
    >
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
              description="Optional. What this policy is for, and who it is meant for."
              status={errors.description === undefined ? undefined : { type: 'error', message: errors.description }}
              onChange={(value) => {
                clearError('description');
                set('description', value);
              }}
            />

            <NumberInput
              label="Priority"
              value={form.priority}
              min={-1000}
              max={1000}
              isIntegerOnly
              hasClear
              description="Between -1000 and 1000. Higher wins across an agent's policies; at equal priority DENY beats ALLOW."
              status={errors.priority === undefined ? undefined : { type: 'error', message: errors.priority }}
              onChange={(value) => {
                clearError('priority');
                set('priority', value);
              }}
            />
          </VStack>
        </Card>

        <Card padding={4}>
          <VStack gap={3}>
            <VStack gap={1}>
              <Text type="label">Rules</Text>
              <Text type="supporting" as="p">
                With no matching rule the answer is deny, so a policy that allows nothing grants nothing. A rule with
                target <Text type="code">*</Text> matches every backend or every tool at that level.
              </Text>
            </VStack>

            {errors.rules === undefined ? null : (
              <Text type="supporting" as="p">
                {errors.rules}
              </Text>
            )}

            {form.rules.length === 0 ? (
              <Text type="supporting" as="p">
                No rules yet. This policy will not grant anything until it has at least one ALLOW rule.
              </Text>
            ) : (
              <VStack gap={3}>
                {form.rules.map((rule, index) => {
                  const targetKey = issueKey(index, 'target');
                  return (
                    <Card key={`${rule.resource}-${index}`} padding={3}>
                      <VStack gap={2}>
                        <HStack gap={2} wrap="wrap" align="end">
                          <div className="min-w-[150px]">
                            <Selector
                              label={`Resource ${index + 1}`}
                              value={rule.resource}
                              options={RESOURCE_OPTIONS}
                              onChange={(value) => changeResource(index, value as PolicyResource)}
                            />
                          </div>

                          <div className="min-w-[240px] flex-1">
                            {rule.resource === 'backend' ? (
                              <Selector
                                label="Backend"
                                value={rule.target}
                                options={[
                                  { value: '', label: 'Choose a backend' },
                                  { value: WILDCARD, label: '* — every backend' },
                                  ...backends.map((backend) => ({ value: backend.id, label: backend.name })),
                                  // A rule can name a backend the registry no longer lists; keeping it as
                                  // an explicit option means saving does not silently drop it.
                                  ...(rule.target !== '' &&
                                  rule.target !== WILDCARD &&
                                  !backends.some((backend) => backend.id === rule.target)
                                    ? [{ value: rule.target, label: `${rule.target} (not in the registry)` }]
                                    : []),
                                ]}
                                status={errors[targetKey] === undefined ? undefined : { type: 'error', message: errors[targetKey] }}
                                onChange={(value) => updateRule(index, { target: value })}
                              />
                            ) : (
                              <TextInput
                                label="Public tool name"
                                value={rule.target}
                                description="e.g. github__search_repositories, or * for every tool. Shape only — a tool need not exist yet."
                                status={errors[targetKey] === undefined ? undefined : { type: 'error', message: errors[targetKey] }}
                                onChange={(value) => updateRule(index, { target: value })}
                              />
                            )}
                          </div>

                          <div className="min-w-[140px]">
                            <Selector
                              label="Effect"
                              value={rule.effect}
                              options={EFFECT_OPTIONS}
                              onChange={(value) => updateRule(index, { effect: value as PolicyEffect })}
                            />
                          </div>

                          <Button
                            label="Remove rule"
                            variant="destructive"
                            size="sm"
                            onClick={() => removeRule(index)}
                          />
                        </HStack>

                        <HStack gap={2} align="center">
                          <Text type="supporting">Rule {index + 1}:</Text>
                          <EffectBadge effect={rule.effect} />
                          <Text type="supporting">
                            {rule.effect === 'allow' ? 'grants' : 'refuses'} {rule.target.trim() === '' ? 'nothing yet' : rule.target.trim()}
                            {rule.resource === 'backend' ? ' (backend)' : ' (tool)'}
                          </Text>
                        </HStack>
                      </VStack>
                    </Card>
                  );
                })}
              </VStack>
            )}

            <HStack gap={2}>
              <Button label="Add rule" variant="secondary" onClick={addRule} />
            </HStack>
          </VStack>
        </Card>

        <HStack gap={2} wrap="wrap">
          <Button
            label={isEdit ? 'Save changes' : 'Create policy'}
            type="submit"
            variant="primary"
            isLoading={pending === 'save'}
            isDisabled={busy}
          />
          <Button
            label="Cancel"
            href={isEdit ? `/dashboard/policies/${policy.id}` : '/dashboard/policies'}
            variant="ghost"
          />
        </HStack>
      </VStack>

      {widenings === undefined ? null : (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setWidenings(undefined);
          }}
          title="This change widens access"
          description={`Saving grants more than the policy currently does, for every agent it is assigned to. ${
            widenings.length === 0 ? '' : `Changes: ${widenings.join('; ')}.`
          }`}
          actionLabel="Save and widen access"
          cancelLabel="Go back"
          actionVariant="primary"
          isActionLoading={pending === 'save'}
          onAction={() => void save()}
        />
      )}
    </form>
  );
}
