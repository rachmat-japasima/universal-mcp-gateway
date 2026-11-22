import { describe, expect, it } from 'vitest';

import type { Backend } from '@/lib/api/types';
import {
  EMPTY_FORM,
  SECRET_REF_PATTERN,
  buildCreateInput,
  formFromBackend,
  issuesToErrors,
  newRow,
  parseArgs,
  toUpdateInput,
} from '@/lib/backends/form';

/**
 * The form model is where the gateway's rules are mirrored, so these are the
 * tests that keep the mirror honest.
 *
 * Two of them are security-relevant rather than ergonomic:
 *
 *  * a shell-looking executable is refused here as well as at the gateway, so
 *    `node server.js` can never become a spawn;
 *  * an `env`/`header` value that is not a `secret:`/`env:` reference is
 *    refused, because the gateway would reject it and the most likely cause is
 *    an operator pasting the secret itself.
 */

const stdioForm = {
  ...EMPTY_FORM,
  name: 'filesystem',
  command: 'npx',
  args: '-y\n@modelcontextprotocol/server-filesystem\n/tmp',
};

describe('parseArgs', () => {
  it('is one argument per line, so spaces inside an argument survive', () => {
    expect(parseArgs('--config=/path/with space.json\n--verbose')).toEqual([
      '--config=/path/with space.json',
      '--verbose',
    ]);
  });

  it('drops blank lines and trims padding, but not embedded spaces', () => {
    expect(parseArgs('\n  a b  \n\n\tc\t\n')).toEqual(['a b', 'c']);
  });

  it('returns an empty array for empty input', () => {
    expect(parseArgs('')).toEqual([]);
  });
});

describe('buildCreateInput', () => {
  it('builds a stdio payload with args as an array', () => {
    const { input, errors } = buildCreateInput(stdioForm);

    expect(errors).toEqual({});
    expect(input).toMatchObject({
      name: 'filesystem',
      connection: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: {} },
      // The form defaults to creating a disabled backend: creation stores
      // configuration only, and enabling is an explicit operator decision.
      enabled: false,
      timeoutMs: 30000,
      concurrencyMode: 'serialized',
    });
  });

  it('builds a streamable-http payload', () => {
    const { input, errors } = buildCreateInput({
      ...EMPTY_FORM,
      name: 'remote',
      transport: 'streamable-http',
      url: 'https://mcp.example.test/sse',
      headers: [newRow('authorization', 'secret:mcp/remote/token')],
    });

    expect(errors).toEqual({});
    expect(input).toMatchObject({
      connection: {
        type: 'streamable-http',
        url: 'https://mcp.example.test/sse',
        headers: { authorization: 'secret:mcp/remote/token' },
      },
    });
  });

  it('refuses an executable that looks like a shell command', () => {
    const { input, errors } = buildCreateInput({ ...stdioForm, command: 'node server.js' });

    expect(input).toBeUndefined();
    expect(errors.command).toContain('one executable');
  });

  it('refuses shell metacharacters in the executable', () => {
    for (const command of ['node;rm', 'node&&rm', '$(whoami)', 'node|cat', 'node`id`', 'node<x']) {
      expect(buildCreateInput({ ...stdioForm, command }).errors.command, command).toBeDefined();
    }
  });

  it('refuses a literal secret as an env value', () => {
    const { input, errors } = buildCreateInput({
      ...stdioForm,
      env: [newRow('API_KEY', 'sk-live-abcdef123456')],
    });

    expect(input).toBeUndefined();
    expect(errors['env.0.value']).toContain('secret:<path>');
  });

  it('accepts both reference forms and rejects a non-reference', () => {
    expect(SECRET_REF_PATTERN.test('secret:providers/github')).toBe(true);
    expect(SECRET_REF_PATTERN.test('env:GITHUB_TOKEN')).toBe(true);
    expect(SECRET_REF_PATTERN.test('literal-value')).toBe(false);
    expect(SECRET_REF_PATTERN.test('secret:')).toBe(false);
  });

  it('refuses an env key that is not a POSIX name', () => {
    const { errors } = buildCreateInput({ ...stdioForm, env: [newRow('not a name', 'env:X')] });
    expect(errors['env.0.key']).toBeDefined();
  });

  it('refuses a duplicated env key', () => {
    const { errors } = buildCreateInput({
      ...stdioForm,
      env: [newRow('TOKEN', 'env:A'), newRow('TOKEN', 'env:B')],
    });
    expect(errors['env.1.key']).toContain('twice');
  });

  it('ignores a half-empty row rather than emitting an empty value', () => {
    const { input, errors } = buildCreateInput({ ...stdioForm, env: [newRow('', '')] });

    expect(errors).toEqual({});
    expect((input?.connection as { env: Record<string, string> }).env).toEqual({});
  });

  it('requires a concurrency limit only in limited mode', () => {
    expect(buildCreateInput({ ...stdioForm, concurrencyMode: 'limited' }).errors.concurrencyLimit).toBeDefined();
    expect(
      buildCreateInput({ ...stdioForm, concurrencyMode: 'limited', concurrencyLimit: '4' }).errors.concurrencyLimit,
    ).toBeUndefined();
  });

  it('rejects a URL that is not http(s)', () => {
    for (const url of ['file:///etc/passwd', 'data:text/plain,x', 'mcp.example.test', 'javascript:alert(1)']) {
      expect(
        buildCreateInput({ ...EMPTY_FORM, name: 'x', transport: 'streamable-http', url }).errors.url,
        url,
      ).toBeDefined();
    }
  });

  it('requires a name', () => {
    expect(buildCreateInput({ ...EMPTY_FORM }).errors.name).toBeDefined();
    expect(buildCreateInput({ ...stdioForm, name: '   ' }).errors.name).toBeDefined();
  });

  it('omits an empty description instead of sending an empty string', () => {
    const { input } = buildCreateInput({ ...stdioForm, description: '   ' });
    expect(input).not.toHaveProperty('description');
  });

  it('rejects a timeout outside the documented bounds', () => {
    expect(buildCreateInput({ ...stdioForm, timeoutMs: '99' }).errors.timeoutMs).toBeDefined();
    expect(buildCreateInput({ ...stdioForm, timeoutMs: '600001' }).errors.timeoutMs).toBeDefined();
    expect(buildCreateInput({ ...stdioForm, timeoutMs: '1.5' }).errors.timeoutMs).toBeDefined();
  });

  it('checks the transport that is selected, not the other one', () => {
    // A stdio form with a URL left over from a transport switch must not fail.
    expect(buildCreateInput({ ...stdioForm, url: 'not-a-url' }).errors.url).toBeUndefined();
    // And an http form with a stale command must not either.
    expect(
      buildCreateInput({ ...EMPTY_FORM, name: 'r', transport: 'streamable-http', url: 'https://a.test', command: 'bad cmd' })
        .errors.command,
    ).toBeUndefined();
  });
});

describe('toUpdateInput', () => {
  it('clears a description that was emptied, rather than leaving the old one', () => {
    const { input } = buildCreateInput(stdioForm);
    const update = toUpdateInput(input!, { ...stdioForm, description: '  ' });

    expect(update.description).toBeNull();
  });

  it('clears the concurrency limit when the mode is no longer limited', () => {
    const { input } = buildCreateInput({ ...stdioForm, concurrencyMode: 'limited', concurrencyLimit: '4' });
    const update = toUpdateInput(input!, { ...stdioForm, concurrencyMode: 'serialized' });

    expect(update.concurrencyLimit).toBeNull();
  });

  it('keeps the limit in limited mode', () => {
    const form = { ...stdioForm, concurrencyMode: 'limited' as const, concurrencyLimit: '8' };
    const { input } = buildCreateInput(form);

    expect(toUpdateInput(input!, form).concurrencyLimit).toBe(8);
  });
});

describe('formFromBackend', () => {
  const backend: Backend = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'filesystem',
    transport: 'stdio',
    connection: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      cwd: '/srv',
      env: { TOKEN: 'secret:fs/token' },
    },
    enabled: false,
    timeoutMs: 15000,
    concurrencyMode: 'limited',
    concurrencyLimit: 2,
    version: 3,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T01:00:00.000Z',
  };

  it('round-trips a stdio configuration into form strings', () => {
    const form = formFromBackend(backend);

    expect(form).toMatchObject({
      name: 'filesystem',
      transport: 'stdio',
      enabled: false,
      command: 'npx',
      args: '-y\nserver',
      cwd: '/srv',
      timeoutMs: '15000',
      concurrencyMode: 'limited',
      concurrencyLimit: '2',
    });
    expect(form.env.map(({ key, value }) => ({ key, value }))).toEqual([{ key: 'TOKEN', value: 'secret:fs/token' }]);
  });

  it('treats an absent description and limit as empty strings, not undefined', () => {
    const form = formFromBackend({ ...backend, description: undefined, concurrencyLimit: undefined });

    expect(form.description).toBe('');
    expect(form.concurrencyLimit).toBe('');
  });

  it('maps an http backend onto the http fields', () => {
    const form = formFromBackend({
      ...backend,
      transport: 'streamable-http',
      connection: { type: 'streamable-http', url: 'https://mcp.test/sse', headers: { authorization: 'env:AUTH' } },
    });

    expect(form.url).toBe('https://mcp.test/sse');
    expect(form.headers.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: 'authorization', value: 'env:AUTH' },
    ]);
  });

  it('round-trips through buildCreateInput unchanged', () => {
    const { input } = buildCreateInput(formFromBackend(backend));

    expect((input?.connection as { args: string[] }).args).toEqual(['-y', 'server']);
    expect((input?.connection as { env: Record<string, string> }).env).toEqual({ TOKEN: 'secret:fs/token' });
  });
});

describe('issuesToErrors', () => {
  it('drops the connection prefix so the error lands on a field', () => {
    expect(issuesToErrors([{ path: 'connection.command', message: 'bad' }])).toEqual({ command: 'bad' });
  });

  it('keeps a redacted env path addressable', () => {
    expect(issuesToErrors([{ path: 'connection.env.(redacted)', message: 'bad key' }])).toEqual({
      'env.(redacted)': 'bad key',
    });
  });

  it('keeps top-level paths as they arrive', () => {
    expect(issuesToErrors([{ path: 'name', message: 'required' }])).toEqual({ name: 'required' });
  });
});
