'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { Backend } from '@/lib/api/types';
import { send } from '@/lib/backends/browser';
import {
  EMPTY_FORM,
  buildCreateInput,
  formFromBackend,
  issuesToErrors,
  newRow,
  toUpdateInput,
  type BackendFormState,
  type FormErrors,
  type SecretRefRow,
} from '@/lib/backends/form';

/**
 * Create and edit, one component.
 *
 * The two flows differ only in where the payload goes: `POST /api/v1/backends`
 * (create) or `PATCH /api/v1/backends/:id?expectedVersion=` (edit). Everything
 * else — the transport switch, secret-reference rows, client-side validation
 * that mirrors the gateway — is identical, so making it two components would
 * duplicate the rules that matter most.
 *
 * Three deliberate properties:
 *
 *  * **Validation is local first, then the gateway's.** `buildCreateInput` runs
 *    the same patterns the domain schema does, so a bad executable or a literal
 *    secret gets an inline message instead of a 400. The gateway's own
 *    `/validate` is used by the explicit "Validate" button, because it is the
 *    only thing that can answer authoritatively.
 *  * **Secrets are references.** Every env/header value must be `secret:<path>`
 *    or `env:<VAR>`. The form never collects a secret value, so there is
 *    nothing to redact from a saved backend and nothing to leak into a browser.
 *  * **Nothing is reported successful before the gateway says so.** A create
 *    navigates to the new detail page; an edit refreshes it.
 *
 * The browser never holds the operator cookie or CSRF token: writes go to the
 * dashboard's own proxy, which supplies both.
 */

const TRANSPORTS = [
  { value: 'stdio', label: 'STDIO' },
  { value: 'streamable-http', label: 'Streamable HTTP' },
];

const CONCURRENCY_OPTIONS = [
  { value: 'parallel', label: 'Parallel' },
  { value: 'serialized', label: 'Serialized' },
  { value: 'limited', label: 'Limited' },
];

type Pending = 'save' | 'validate' | null;

export function BackendForm({ backend }: { backend?: Backend }): React.ReactElement {
  const router = useRouter();
  const isEdit = backend !== undefined;

  const [form, setForm] = useState<BackendFormState>(() =>
    backend === undefined ? EMPTY_FORM : formFromBackend(backend),
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [banner, setBanner] = useState<{ status: 'error' | 'success' | 'info'; text: string } | undefined>(undefined);
  const [pending, setPending] = useState<Pending>(null);

  const set = <K extends keyof BackendFormState>(key: K, value: BackendFormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  /** A field's inline error, cleared as soon as the field is edited. */
  const status = (field: string): { type: 'error'; message: string } | undefined =>
    errors[field] === undefined ? undefined : { type: 'error', message: errors[field]! };

  function clearError(field: string): void {
    setErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function onValidate(): void {
    setBanner(undefined);
    const { input, errors: found } = buildCreateInput(form);
    setErrors(found);

    if (input === undefined) {
      setBanner({ status: 'error', text: 'Fix the highlighted fields, then validate again.' });
      return;
    }

    setPending('validate');
    void send<{ valid: boolean; errors?: Array<{ path: string; message: string }> }>('/api/backends/validate', {
      method: 'POST',
      body: input,
    })
      .then((result) => {
        setPending(null);

        if (!result.ok) {
          setBanner({ status: 'error', text: result.message ?? 'Validation could not be completed.' });
          return;
        }

        const answer = result.data;
        if (answer === undefined) {
          setBanner({ status: 'error', text: 'The gateway returned an unexpected validation response.' });
          return;
        }

        if (answer.valid) {
          setBanner({ status: 'success', text: 'The gateway accepted this configuration. Nothing was saved or connected.' });
          return;
        }

        const mapped = issuesToErrors(answer.errors ?? []);
        setErrors(mapped);
        setBanner({ status: 'error', text: 'The gateway rejected this configuration. See the fields below.' });
      })
      // `send` returns rather than throwing, so this only fires on a bug in it;
      // keeping it prevents a permanently pending button.
      .catch(() => {
        setPending(null);
        setBanner({ status: 'error', text: 'Validation could not be completed.' });
      });
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    // A second submit while a request is in flight must not create a second
    // backend. The buttons are disabled, but a form can also be submitted by
    // pressing Enter in a field.
    if (pending !== null) return;

    setBanner(undefined);

    const { input, errors: found } = buildCreateInput(form);
    setErrors(found);

    if (input === undefined) {
      setBanner({ status: 'error', text: 'Fix the highlighted fields before saving.' });
      return;
    }

    setPending('save');

    const body = isEdit ? toUpdateInput(input, form) : input;
    const path = isEdit ? `/api/backends/${backend.id}?expectedVersion=${backend.version}` : '/api/backends';

    void send<Backend>(path, { method: isEdit ? 'PATCH' : 'POST', body })
      .then((result) => {
        setPending(null);

        if (!result.ok) {
          setBanner({ status: 'error', text: result.message ?? 'The gateway rejected the request.' });
          return;
        }

        if (isEdit) {
          router.refresh();
          return;
        }

        const created = result.data;
        if (created === undefined) {
          // Created, but the answer did not name the new backend. The list is
          // the honest destination: it re-reads from the gateway.
          router.push('/dashboard/backends');
          return;
        }

        router.push(`/dashboard/backends/${created.id}`);
      })
      .catch(() => {
        setPending(null);
        setBanner({ status: 'error', text: 'The request could not be completed.' });
      });
  }

  const busy = pending !== null;

  return (
    <form onSubmit={onSubmit} noValidate>
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
              status={status('name')}
              onChange={(value) => {
                clearError('name');
                set('name', value);
              }}
            />

            <TextArea
              label="Description"
              value={form.description}
              rows={3}
              description="Optional. Shown in the list and on the detail page."
              status={status('description')}
              onChange={(value) => {
                clearError('description');
                set('description', value);
              }}
            />

            <Switch
              label="Enabled"
              value={form.enabled}
              description="Enabled backends may be connected. Disabled ones cannot dial at all."
              onChange={(checked) => set('enabled', checked)}
            />
          </VStack>
        </Card>

        <Card padding={4}>
          <VStack gap={3}>
            <SegmentedControl
              label="Transport"
              value={form.transport}
              onChange={(value) => set('transport', value as BackendFormState['transport'])}
            >
              {TRANSPORTS.map((transport) => (
                <SegmentedControlItem key={transport.value} value={transport.value} label={transport.label} />
              ))}
            </SegmentedControl>

            {form.transport === 'stdio' ? (
              <StdioFields form={form} errors={errors} set={set} clearError={clearError} />
            ) : (
              <HttpFields form={form} errors={errors} set={set} clearError={clearError} />
            )}
          </VStack>
        </Card>

        <Card padding={4}>
          <VStack gap={3}>
            <TextInput
              label="Timeout (ms)"
              value={form.timeoutMs}
              inputMode="numeric"
              description="Per-call timeout handed to the adapter. 100 to 600000."
              status={status('timeoutMs')}
              onChange={(value) => {
                clearError('timeoutMs');
                set('timeoutMs', value);
              }}
            />

            <Selector
              label="Concurrency"
              value={form.concurrencyMode}
              options={CONCURRENCY_OPTIONS}
              description="How calls to this backend are scheduled."
              onChange={(value) => set('concurrencyMode', value as BackendFormState['concurrencyMode'])}
            />

            {form.concurrencyMode === 'limited' ? (
              <TextInput
                label="Concurrency limit"
                value={form.concurrencyLimit}
                inputMode="numeric"
                description="Maximum simultaneous calls. 1 to 64."
                status={status('concurrencyLimit')}
                onChange={(value) => {
                  clearError('concurrencyLimit');
                  set('concurrencyLimit', value);
                }}
              />
            ) : null}
          </VStack>
        </Card>

        <HStack gap={2} wrap="wrap">
          <Button
            label={isEdit ? 'Save changes' : 'Create backend'}
            type="submit"
            variant="primary"
            isLoading={pending === 'save'}
            isDisabled={busy}
          />
          <Button
            label="Validate configuration"
            variant="secondary"
            onClick={onValidate}
            isLoading={pending === 'validate'}
            isDisabled={busy}
          />
          <Button label="Cancel" href={isEdit ? `/dashboard/backends/${backend.id}` : '/dashboard/backends'} variant="ghost" />
        </HStack>
      </VStack>
    </form>
  );
}

type Setter = <K extends keyof BackendFormState>(key: K, value: BackendFormState[K]) => void;

interface FieldProps {
  form: BackendFormState;
  errors: FormErrors;
  set: Setter;
  clearError: (field: string) => void;
}

function StdioFields({ form, errors, set, clearError }: FieldProps): React.ReactElement {
  return (
    <VStack gap={3}>
      <TextInput
        label="Executable"
        value={form.command}
        isRequired
        description="One executable only, e.g. node or /usr/local/bin/mcp-server. Arguments belong below."
        status={errors.command === undefined ? undefined : { type: 'error', message: errors.command }}
        onChange={(value) => {
          clearError('command');
          set('command', value);
        }}
      />

      <TextArea
        label="Arguments"
        value={form.args}
        rows={4}
        description="One argument per line. Line breaks are preserved, so paths containing spaces stay one argument."
        status={errors.args === undefined ? undefined : { type: 'error', message: errors.args }}
        onChange={(value) => {
          clearError('args');
          set('args', value);
        }}
      />

      <TextInput
        label="Working directory"
        value={form.cwd}
        description="Optional. Relative paths resolve against the gateway's own working directory."
        status={errors.cwd === undefined ? undefined : { type: 'error', message: errors.cwd }}
        onChange={(value) => {
          clearError('cwd');
          set('cwd', value);
        }}
      />

      <ReferenceRows
        legend="Environment"
        description="Values are references, never secrets: secret:<path> or env:<VAR>. The dashboard never stores a literal value."
        keyLabel="Variable name"
        rows={form.env}
        errors={errors}
        prefix="env"
        onChange={(rows) => set('env', rows)}
      />
    </VStack>
  );
}

function HttpFields({ form, errors, set, clearError }: FieldProps): React.ReactElement {
  return (
    <VStack gap={3}>
      <TextInput
        label="Endpoint URL"
        type="url"
        value={form.url}
        isRequired
        description="An absolute http:// or https:// URL. The gateway validates it; the dashboard does not bypass that."
        status={errors.url === undefined ? undefined : { type: 'error', message: errors.url }}
        onChange={(value) => {
          clearError('url');
          set('url', value);
        }}
      />

      <ReferenceRows
        legend="Request headers"
        description="Values are references, never secrets: secret:<path> or env:<VAR>."
        keyLabel="Header name"
        rows={form.headers}
        errors={errors}
        prefix="headers"
        onChange={(rows) => set('headers', rows)}
      />
    </VStack>
  );
}

/**
 * The env/header editor.
 *
 * A row is `key` + reference. The add button appends a blank row rather than
 * submitting a template, and each row can be removed — an empty pair is ignored
 * by `buildCreateInput`, so a half-filled row never becomes a stray `KEY=""`.
 */
function ReferenceRows({
  legend,
  description,
  keyLabel,
  rows,
  errors,
  prefix,
  onChange,
}: {
  legend: string;
  description: string;
  keyLabel: string;
  rows: SecretRefRow[];
  errors: FormErrors;
  prefix: 'env' | 'headers';
  onChange: (rows: SecretRefRow[]) => void;
}): React.ReactElement {
  const update = (index: number, patch: Partial<SecretRefRow>): void => {
    onChange(rows.map((row, current) => (current === index ? { ...row, ...patch } : row)));
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{legend}</legend>
      <Text type="supporting" as="p">
        {description}
      </Text>

      {rows.map((row, index) => (
        <div key={row.id} className="flex flex-wrap items-start gap-2">
          <TextInput
            label={`${keyLabel} ${index + 1}`}
            isLabelHidden
            value={row.key}
            placeholder={keyLabel}
            status={
              errors[`${prefix}.${index}.key`] === undefined
                ? undefined
                : { type: 'error', message: errors[`${prefix}.${index}.key`]! }
            }
            onChange={(value) => update(index, { key: value })}
          />
          <TextInput
            label={`${keyLabel} ${index + 1} reference`}
            isLabelHidden
            value={row.value}
            placeholder="secret:<path> or env:<VAR>"
            status={
              errors[`${prefix}.${index}.value`] === undefined
                ? undefined
                : { type: 'error', message: errors[`${prefix}.${index}.value`]! }
            }
            onChange={(value) => update(index, { value })}
          />
          <IconButton
            label={`Remove ${keyLabel} ${index + 1}`}
            icon={<span aria-hidden="true">✕</span>}
            variant="ghost"
            size="sm"
            onClick={() => onChange(rows.filter((_, current) => current !== index))}
          />
        </div>
      ))}

      <div>
        <Button label={`Add ${legend.toLowerCase()} entry`} variant="secondary" size="sm" onClick={() => onChange([...rows, newRow()])} />
      </div>

      {errors[prefix] === undefined ? null : (
        <Text type="supporting" as="p">
          {errors[prefix]}
        </Text>
      )}
    </fieldset>
  );
}
