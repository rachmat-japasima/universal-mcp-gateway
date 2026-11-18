import pino, { type Logger as PinoLogger } from 'pino';

import type { Config } from '../config/config.js';

export type Logger = PinoLogger;

/**
 * Serializers so a secret cannot reach a log by accident:
 *   * authorization/cookie headers are dropped entirely,
 *   * credential-ish keys inside nested objects are masked.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  '*.token',
  '*.credential',
  '*.credentialHash',
  '*.password',
  '*.secret',
  '*.apiKey',
];

export function createLogger(config: Pick<Config, 'logLevel' | 'environment'>): Logger {
  return pino({
    name: 'universal-mcp-gateway',
    level: config.logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  });
}
