import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';

import type { Config } from '../config/config.js';

export type Logger = PinoLogger;

/**
 * Serializers so a secret cannot reach a log by accident:
 *   * authorization/cookie headers are dropped entirely — request-level and
 *     at any nesting depth (`*.` wildcards);
 *   * credential-ish keys inside nested objects are masked.
 *
 * Session ids, agent ids and backend ids are deliberately NOT redacted: they
 * are routing handles with no authenticating power (see `docs/SECURITY.md`),
 * and correlating an incident without them is the point of structured logs.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-csrf-token"]',
  // Bare names: a top-level credential field is always a leak.
  'authorization',
  'cookie',
  'token',
  'credential',
  'credentialHash',
  'password',
  'passwordHash',
  'secret',
  'apiKey',
  'csrfToken',
  'accessToken',
  'refreshToken',
  'clientSecret',
  // One level deep: serializers and nested detail objects.
  '*.authorization',
  '*.cookie',
  '*.token',
  '*.credential',
  '*.credentialHash',
  '*.password',
  '*.passwordHash',
  '*.secret',
  '*.apiKey',
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
];

export interface LoggerOptions {
  /**
   * Capture sink for tests. Production logs go to stdout (pino's default);
   * tests need the serialized lines in memory to assert redaction and shape.
   */
  destination?: DestinationStream;
}

export function createLogger(
  config: Pick<Config, 'logLevel' | 'environment'>,
  options: LoggerOptions = {},
): Logger {
  const configuration = {
    name: 'universal-mcp-gateway',
    level: config.logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };

  // pino takes a generic writable as its second constructor argument; there
  // is no `stream` option key, and `destination` expects an fd or a
  // `pino.destination()` handle.
  return options.destination === undefined ? pino(configuration) : pino(configuration, options.destination);
}
