import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadConfig, parseConfig, redactConfig, type Config } from '../src/config/config.js';

/** Fails the test with the actual issues instead of a bare `expect(false).toBe(true)`. */
function expectValidParse(env: Parameters<typeof parseConfig>[0], overrides: Partial<Config> = {}): Config {
  const result = parseConfig(env, overrides);
  if (!result.ok) throw new Error(`unexpected config issues: ${JSON.stringify(result.issues)}`);
  return result.config;
}

describe('configuration defaults', () => {
  it('uses loopback defaults when nothing is set', () => {
    expect(expectValidParse({})).toMatchObject({
      host: '127.0.0.1',
      port: 8787,
      databasePath: fileURLToPath(new URL('../../../data/gateway.db', import.meta.url)),
      logLevel: 'info',
      environment: 'development',
      mcpEndpoint: '/mcp',
      healthEndpoint: '/health',
    });
  });

  it('anchors the default and any relative DATABASE_PATH to the repository root', () => {
    // Both expected values are computed from this test file, not from the
    // implementation's constant: the contract is *where the database lives*,
    // independent of the process working directory (repo root, apps/gateway,
    // or a supervisor's cwd must all mean the same file).
    expect(expectValidParse({}).databasePath).toBe(fileURLToPath(new URL('../../../data/gateway.db', import.meta.url)));
    expect(expectValidParse({ DATABASE_PATH: './nested/gw.db' }).databasePath).toBe(
      fileURLToPath(new URL('../../../nested/gw.db', import.meta.url)),
    );
  });

  it('keeps the endpoint contract fixed', () => {
    expect(parseConfig({}, { mcpEndpoint: '/mcp' }).ok).toBe(true);
  });
});

describe('environment overrides', () => {
  it('applies every supported variable', () => {
    expect(
      expectValidParse({
        ENVIRONMENT: 'test',
        HOST: 'localhost',
        PORT: '9000',
        DATABASE_PATH: '/tmp/opencode/gw.db',
        LOG_LEVEL: 'debug',
        REQUEST_TIMEOUT_MS: '5000',
        SESSION_IDLE_TIMEOUT_MS: '120000',
      }),
    ).toMatchObject({
      environment: 'test',
      host: 'localhost',
      port: 9000,
      databasePath: '/tmp/opencode/gw.db',
      logLevel: 'debug',
      requestTimeoutMs: 5000,
      sessionIdleTimeoutMs: 120_000,
    });
  });

  it('treats empty strings as unset rather than as values', () => {
    expect(expectValidParse({ PORT: '', LOG_LEVEL: '' })).toMatchObject({ port: 8787, logLevel: 'info' });
  });

  it('lets explicit overrides win over environment values', () => {
    expect(expectValidParse({ PORT: '9000' }, { port: 9100 }).port).toBe(9100);
  });
});

describe('invalid configuration is rejected', () => {
  it('rejects a non-loopback host', () => {
    // Network exposure is a deliberate security gate, not a config toggle.
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      expect(parseConfig({ HOST: host }).ok).toBe(false);
    }
  });

  it('rejects an invalid port', () => {
    for (const port of ['0', '65536', '-1', 'abc', '80.5']) {
      expect(parseConfig({ PORT: port }).ok).toBe(false);
    }
  });

  it('rejects an empty database path', () => {
    expect(parseConfig({ DATABASE_PATH: '   ' }).ok).toBe(false);
  });

  it('rejects a null byte in the database path', () => {
    expect(parseConfig({ DATABASE_PATH: './data/gw\0.db' }).ok).toBe(false);
  });

  it('rejects unknown environments and log levels', () => {
    expect(parseConfig({ ENVIRONMENT: 'staging' }).ok).toBe(false);
    expect(parseConfig({ LOG_LEVEL: 'verbose' }).ok).toBe(false);
  });

  it('reports which setting failed', () => {
    const result = parseConfig({ PORT: 'abc', HOST: '0.0.0.0' });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const paths = result.issues.map((issue) => issue.path.join('.'));
    expect(paths).toContain('port');
    expect(paths).toContain('host');
  });

  it('throws a ConfigError from loadConfig without exiting the process', () => {
    expect(() => loadConfig({ PORT: 'nope' })).toThrowError(/Invalid gateway configuration/);
  });
});

describe('redaction', () => {
  it('exposes only the non-secret configuration keys', () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const redacted = redactConfig(config);

    expect(Object.keys(redacted).sort()).toEqual(Object.keys(config).sort());
    expect(JSON.stringify(redacted)).not.toMatch(/password|token|secret|apiKey/i);
  });
});

describe('lifecycle configuration', () => {
  it('defaults to no automatic reconnect and no private-network access', () => {
    expect(expectValidParse({})).toMatchObject({
      reconnectEnabled: false,
      reconnectInitialDelayMs: 1_000,
      reconnectMaxDelayMs: 60_000,
      reconnectMaxAttempts: 5,
      reconnectJitterRatio: 0.2,
      allowPrivateNetwork: false,
    });
  });

  it('reads every lifecycle variable', () => {
    expect(
      expectValidParse({
        RECONNECT_ENABLED: 'true',
        RECONNECT_INITIAL_DELAY_MS: '500',
        RECONNECT_MAX_DELAY_MS: '5000',
        RECONNECT_MAX_ATTEMPTS: '3',
        RECONNECT_JITTER_RATIO: '0.5',
        ALLOW_PRIVATE_NETWORK: 'true',
      }),
    ).toMatchObject({
      reconnectEnabled: true,
      reconnectInitialDelayMs: 500,
      reconnectMaxDelayMs: 5_000,
      reconnectMaxAttempts: 3,
      reconnectJitterRatio: 0.5,
      allowPrivateNetwork: true,
    });
  });

  it('rejects out-of-range lifecycle values', () => {
    for (const env of [
      { RECONNECT_ENABLED: 'yes' },
      { RECONNECT_INITIAL_DELAY_MS: '10' },
      { RECONNECT_MAX_ATTEMPTS: '0' },
      { RECONNECT_MAX_ATTEMPTS: '101' },
      { RECONNECT_JITTER_RATIO: '2' },
      { RECONNECT_JITTER_RATIO: '-0.1' },
      { ALLOW_PRIVATE_NETWORK: 'sometimes' },
    ]) {
      expect(parseConfig(env).ok, JSON.stringify(env)).toBe(false);
    }
  });
});
