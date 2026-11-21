import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/monitoring/logger.js';
import { captureLog } from './helpers/log-capture.js';

/**
 * Logging contract: one JSON shape, and a hard guarantee that a secret cannot
 * reach a line by accident. Everything asserted here is behaviour an operator
 * or a log pipeline depends on.
 */

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

function logger(level: (typeof LEVELS)[number] = 'info') {
  const capture = captureLog();
  return { log: createLogger({ logLevel: level, environment: 'test' }, { destination: capture.stream }), lines: capture.lines };
}

describe('structured output', () => {
  it('emits JSON with level, ISO timestamp, service name and message', () => {
    const { log, lines } = logger();

    log.info({ requestId: 'req-1' }, 'Something happened');

    const [line] = lines();
    expect(line).toMatchObject({ level: 30, name: 'universal-mcp-gateway', msg: 'Something happened', requestId: 'req-1' });
    expect(typeof line['time']).toBe('string');
    expect(() => new Date(line['time'] as string)).not.toThrow();
    expect(new Date(line['time'] as string).toISOString()).toBe(line['time']);
  });

  it('supports the full level set and honours the configured ceiling', () => {
    const { log, lines } = logger('warn');

    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn({ code: 'X' }, 'w');
    log.error({ err: new Error('boom') }, 'e');
    log.fatal('f');

    const messages = lines().map((line) => line['msg']);
    expect(messages).toEqual(['w', 'e', 'f']);

    // The error is serialized with its stack, not dropped or stringified raw.
    const errorLine = lines().find((line) => line['msg'] === 'e');
    expect((errorLine?.['err'] as { message: string }).message).toBe('boom');
    expect(typeof (errorLine?.['err'] as { stack: string }).stack).toBe('string');
  });

  it('omits fields that were never supplied rather than fabricating them', () => {
    const { log, lines } = logger();

    log.info({ component: 'lifecycle' }, 'Event');

    const [line] = lines();
    expect(line).not.toHaveProperty('requestId');
    expect(line).not.toHaveProperty('correlationId');
    expect(line).not.toHaveProperty('agentId');
    expect(line).not.toHaveProperty('sessionId');
    expect(line).not.toHaveProperty('backendId');
    expect(line).not.toHaveProperty('durationMs');
    expect(line).not.toHaveProperty('errorCode');
  });
});

describe('redaction', () => {
  it('drops authorization and cookie headers wherever they appear', () => {
    const { log, lines } = logger();

    log.warn(
      {
        req: { headers: { authorization: 'Bearer tok', cookie: 'umg_operator=x' } },
        headers: { authorization: 'Bearer tok2' },
        res: { headers: { 'set-cookie': ['umg_operator=y'] } },
      },
      'Request',
    );

    const [line] = lines();
    expect(JSON.stringify(line)).not.toContain('tok');
    expect(JSON.stringify(line)).not.toContain('umg_operator');
    expect(JSON.stringify(line)).toContain('[REDACTED]');
  });

  it('masks credential-shaped keys at the top level and one level deep', () => {
    const { log, lines } = logger();

    log.info(
      {
        token: 't1',
        password: 'p1',
        passwordHash: 'h1',
        secret: 's1',
        apiKey: 'k1',
        accessToken: 'a1',
        refreshToken: 'r1',
        clientSecret: 'c1',
        credential: 'cred1',
        credentialHash: 'ch1',
        csrfToken: 'csrf1',
        operator: { token: 't2', password: 'p2', secret: 's2' },
        backend: { apiKey: 'k2', clientSecret: 'c2' },
      },
      'Detail',
    );

    const serialized = JSON.stringify(lines()[0]);
    for (const value of ['t1', 'p1', 'h1', 's1', 'k1', 'a1', 'r1', 'c1', 'cred1', 'ch1', 'csrf1', 't2', 'p2', 's2', 'k2', 'c2']) {
      expect(serialized).not.toContain(`"${value}"`);
    }
    expect(serialized).toContain('[REDACTED]');
  });

  it('keeps routing handles and bounded operational fields readable', () => {
    const { log, lines } = logger();

    log.info(
      {
        requestId: 'req-9',
        correlationId: 'corr-9',
        agentId: '11111111-1111-4111-8111-111111111111',
        sessionId: 'mcp-session-handle',
        backendId: '22222222-2222-4222-8222-222222222222',
        toolId: 'demo_echo',
        durationMs: 42,
        errorCode: 'BACKEND_TIMEOUT',
      },
      'Call',
    );

    const [line] = lines();
    expect(line).toMatchObject({ requestId: 'req-9', correlationId: 'corr-9', durationMs: 42, errorCode: 'BACKEND_TIMEOUT' });
    expect(line['agentId']).toBe('11111111-1111-4111-8111-111111111111');
    expect(line['sessionId']).toBe('mcp-session-handle');
  });
});
