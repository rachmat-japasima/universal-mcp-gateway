import type { Backend, BackendConnection, SecretRef } from '@/lib/api/types';

/**
 * The backend form's pure core.
 *
 * Everything here is a plain function over strings, which is the point: the
 * rules that decide what gets sent to the gateway are testable without a
 * browser, a gateway, or a React tree. The components in
 * `features/backends/` only move strings in and out of this.
 *
 * Two rules the gateway enforces and this module must not fight:
 *
 *  * **No shell strings.** `command` is one executable token, and args are an
 *    array. This module splits nothing and quotes nothing — a user who types
 *    `node server.js` gets a field error here, not a shell in the gateway.
 *  * **Secrets are references.** `env` and `headers` values must be
 *    `secret:<path>` or `env:<VAR>`. A literal value is rejected by
 *    `secretRefSchema`, and the dashboard has no business collecting one.
 */

export type TransportChoice = 'stdio' | 'streamable-http';

/** A single `KEY=value` row in the env/headers editor. `value` is a reference. */
export interface SecretRefRow {
  /** Stable React key. Not sent anywhere. */
  id: string;
  key: string;
  value: string;
}

export interface BackendFormState {
  name: string;
  description: string;
  transport: TransportChoice;
  enabled: boolean;
  timeoutMs: string;
  concurrencyMode: 'parallel' | 'serialized' | 'limited';
  concurrencyLimit: string;
  // stdio
  command: string;
  args: string;
  cwd: string;
  env: SecretRefRow[];
  // streamable-http
  url: string;
  headers: SecretRefRow[];
}

export type FormErrors = Record<string, string>;

export const SECRET_REF_PATTERN = /^(?:secret|env):[A-Za-z0-9._:/-]+$/;
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
/** Mirrors the gateway's `SHELL_SYNTAX` check on `command`. */
const SHELL_SYNTAX = /[\s;&|<>`$()]/;

export const EMPTY_FORM: BackendFormState = {
  name: '',
  description: '',
  transport: 'stdio',
  enabled: true,
  timeoutMs: '30000',
  concurrencyMode: 'serialized',
  concurrencyLimit: '',
  command: '',
  args: '',
  cwd: '',
  env: [],
  url: '',
  headers: [],
};

let rowCounter = 0;

/** Ids only need to be unique within one form; a counter is enough and never ships. */
export function newRow(key = '', value = ''): SecretRefRow {
  rowCounter += 1;
  return { id: `row-${rowCounter}`, key, value };
}

/**
 * Turns a saved backend into form strings.
 *
 * Used by the edit form, so it has to survive every shape `toPublicBackend()`
 * can produce: `description` may be absent, `args` may be empty, and either
 * secret map may be empty. Nothing is invented — an absent description becomes
 * an empty string, which is what an empty description round-trips to.
 */
export function formFromBackend(backend: Backend): BackendFormState {
  const base: BackendFormState = {
    ...EMPTY_FORM,
    name: backend.name,
    description: backend.description ?? '',
    transport: backend.connection.type,
    enabled: backend.enabled,
    timeoutMs: String(backend.timeoutMs),
    concurrencyMode: backend.concurrencyMode,
    concurrencyLimit: backend.concurrencyLimit === undefined ? '' : String(backend.concurrencyLimit),
  };

  if (backend.connection.type === 'stdio') {
    return {
      ...base,
      command: backend.connection.command,
      args: backend.connection.args.join('\n'),
      cwd: backend.connection.cwd ?? '',
      env: Object.entries(backend.connection.env).map(([key, value]) => newRow(key, value)),
    };
  }

  return {
    ...base,
    url: backend.connection.url,
    headers: Object.entries(backend.connection.headers).map(([key, value]) => newRow(key, value)),
  };
}

/**
 * Args are one-per-line, not space-separated.
 *
 * Splitting on whitespace would silently destroy an argument that contains a
 * space (`--config=/path/with space.json`) — a real config file path, turned
 * into two wrong arguments with no error. One per line is unambiguous and is
 * the format the empty case round-trips to.
 */
export function parseArgs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function rowsToRecord(
  rows: SecretRefRow[],
  keyPattern: RegExp,
  keyLabel: string,
  errors: FormErrors,
  field: string,
  seen: Set<string>,
): Record<string, SecretRef> {
  const record: Record<string, SecretRef> = {};

  rows.forEach((row, index) => {
    const key = row.key.trim();
    const value = row.value.trim();
    if (key === '' && value === '') return;

    if (key === '') {
      errors[`${field}.${index}.key`] = `Enter a ${keyLabel}.`;
      return;
    }
    if (!keyPattern.test(key)) {
      errors[`${field}.${index}.key`] = `"${key}" is not a valid ${keyLabel}.`;
      return;
    }
    if (seen.has(key)) {
      errors[`${field}.${index}.key`] = `"${key}" is listed twice.`;
      return;
    }
    if (!SECRET_REF_PATTERN.test(value)) {
      // The most likely mistake by far is pasting the secret itself. Say why.
      errors[`${field}.${index}.value`] =
        'Use a reference: "secret:<path>" or "env:<VAR>". Literal values are never stored.';
      return;
    }

    seen.add(key);
    record[key] = value;
  });

  return record;
}

/**
 * Validates the form and builds the request payload.
 *
 * Returns both so a caller cannot accidentally submit while ignoring a field
 * error: `errors` being empty is the only reason to use `input`.
 */
export function buildCreateInput(form: BackendFormState): {
  input: Record<string, unknown> | undefined;
  errors: FormErrors;
} {
  const errors: FormErrors = {};

  const name = form.name.trim();
  if (name === '') errors.name = 'Enter a name.';
  else if (name.length > 120) errors.name = 'Names are at most 120 characters.';

  if (form.description.trim().length > 2000) errors.description = 'Descriptions are at most 2000 characters.';

  const timeout = Number(form.timeoutMs);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 600_000) {
    errors.timeoutMs = 'Use a whole number of milliseconds between 100 and 600000.';
  }

  if (form.concurrencyMode === 'limited') {
    const limit = Number(form.concurrencyLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) {
      errors.concurrencyLimit = 'A limited mode needs a whole number between 1 and 64.';
    }
  }

  let connection: BackendConnection | undefined;

  if (form.transport === 'stdio') {
    const command = form.command.trim();
    if (command === '') errors.command = 'Enter the executable to run.';
    else if (command.length > 1024) errors.command = 'Executables are at most 1024 characters.';
    else if (SHELL_SYNTAX.test(command)) {
      // The gateway rejects this too; catching it here keeps the message next to
      // the field instead of turning the whole submit into a 400.
      errors.command = 'Enter one executable only. Put flags and arguments in Arguments.';
    }

    const cwd = form.cwd.trim();
    if (cwd !== '' && cwd.length > 1024) errors.cwd = 'Working directories are at most 1024 characters.';

    const env = rowsToRecord(form.env, ENV_NAME_PATTERN, 'variable name', errors, 'env', new Set());
    const args = parseArgs(form.args);
    if (args.length > 64) errors.args = 'At most 64 arguments.';
    if (args.some((arg) => arg.length > 4096)) errors.args = 'Arguments are at most 4096 characters each.';

    if (command !== '' && !SHELL_SYNTAX.test(command)) {
      connection = {
        type: 'stdio',
        command,
        args,
        ...(cwd === '' ? {} : { cwd }),
        env,
      };
    }
  } else {
    const url = form.url.trim();
    if (url === '') {
      errors.url = 'Enter the endpoint URL.';
    } else if (!isHttpUrl(url)) {
      errors.url = 'Use an absolute http:// or https:// URL.';
    }

    const headers = rowsToRecord(form.headers, HEADER_NAME_PATTERN, 'header name', errors, 'headers', new Set());
    if (url !== '' && isHttpUrl(url)) connection = { type: 'streamable-http', url, headers };
  }

  if (Object.keys(errors).length > 0 || connection === undefined) {
    return { input: undefined, errors };
  }

  return {
    input: {
      name,
      ...(form.description.trim() === '' ? {} : { description: form.description.trim() }),
      connection,
      enabled: form.enabled,
      timeoutMs: timeout,
      concurrencyMode: form.concurrencyMode,
      ...(form.concurrencyMode === 'limited' ? { concurrencyLimit: Number(form.concurrencyLimit) } : {}),
    },
    errors,
  };
}

/**
 * `z.url({ protocol: /^https?$/ })` on the gateway side; this is the same rule
 * expressed locally so the message can be specific. Anything else — `file:`,
 * `data:`, a bare host — is refused rather than quietly normalised into a URL
 * the gateway would then dial.
 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Maps a gateway error to the field it is about.
 *
 * `VALIDATION_ERROR` messages arrive as `path: message` joined by `;`
 * (`formatZodIssues`), and the validate endpoint returns `{path, message}`
 * pairs directly. Both are recognised so a bad `env` row highlights that row
 * instead of only producing a banner at the top of the form.
 *
 * Note that the gateway redacts unknown segments in a path (`(redacted)`), so a
 * message about an env *key* may arrive as `connection.env.(redacted)`. A path
 * this function cannot place still produces an entry, and the caller renders
 * leftovers as a banner rather than dropping them.
 */
export function issuesToErrors(issues: Array<{ path: string; message: string }>): FormErrors {
  const errors: FormErrors = {};

  for (const issue of issues) {
    // `connection.args.3` and `connection.env.FOO` both become their field key.
    const path = issue.path.replace(/^connection\./, '');
    errors[path] = issue.message;
  }

  return errors;
}

/**
 * The edit payload.
 *
 * `updateBackendSchema` distinguishes "leave alone" (`undefined`) from "clear"
 * (`null`), so a form submission has to be explicit about both nullable fields:
 *
 *  * an emptied description is a request to clear it, not to keep the old one;
 *  * a limit must be dropped when the mode is no longer `limited`, because the
 *    schema rejects a limit that exists beside another mode.
 *
 * Everything is sent, not just the changed fields: the form shows the whole
 * configuration, so "save" means "make it look like this".
 */
export function toUpdateInput(input: Record<string, unknown>, form: BackendFormState): Record<string, unknown> {
  const description = form.description.trim();

  return {
    ...input,
    description: description === '' ? null : description,
    concurrencyLimit: form.concurrencyMode === 'limited' ? Number(form.concurrencyLimit) : null,
  };
}

