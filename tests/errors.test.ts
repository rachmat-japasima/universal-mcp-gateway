import { describe, expect, it } from 'vitest';

import {
  AppError,
  describeErrorForLog,
  errorDefinition,
  isClientFault,
  toAppError,
  type ErrorCode,
} from '../src/shared/errors.js';

const CODES: ErrorCode[] = [
  'VALIDATION_ERROR',
  'CONFIGURATION_ERROR',
  'AUTHENTICATION_ERROR',
  'AUTHORIZATION_ERROR',
  'RESOURCE_NOT_FOUND',
  'RESOURCE_CONFLICT',
  'MCP_PROTOCOL_ERROR',
  'BACKEND_CONNECTION_ERROR',
  'BACKEND_TIMEOUT',
  'BACKEND_UNAVAILABLE',
  'DATABASE_ERROR',
  'INTERNAL_ERROR',
];

describe('error definitions', () => {
  it('defines a category, http status and json-rpc code for every stable code', () => {
    for (const code of CODES) {
      const definition = errorDefinition(code);
      expect(definition.httpStatus).toBeGreaterThanOrEqual(400);
      expect(Number.isInteger(definition.jsonRpcCode)).toBe(true);
      expect(['client', 'denied', 'unavailable', 'internal']).toContain(definition.category);
    }
  });

  it('maps each category to a status a client can act on', () => {
    const status = (code: ErrorCode) => errorDefinition(code).httpStatus;

    expect(status('VALIDATION_ERROR')).toBe(400);
    expect(status('AUTHENTICATION_ERROR')).toBe(401);
    expect(status('AUTHORIZATION_ERROR')).toBe(403);
    expect(status('RESOURCE_NOT_FOUND')).toBe(404);
    expect(status('RESOURCE_CONFLICT')).toBe(409);
    expect(status('BACKEND_TIMEOUT')).toBe(504);
    expect(status('BACKEND_UNAVAILABLE')).toBe(503);
    expect(status('INTERNAL_ERROR')).toBe(500);
  });

  it('uses the standard JSON-RPC parse/invalid-request codes where they apply', () => {
    expect(errorDefinition('MCP_PROTOCOL_ERROR').jsonRpcCode).toBe(-32600);
    expect(errorDefinition('VALIDATION_ERROR').jsonRpcCode).toBe(-32602);
    expect(errorDefinition('INTERNAL_ERROR').jsonRpcCode).toBe(-32603);
  });
});

describe('serialization', () => {
  it('produces a client envelope with the code and safe message only', () => {
    const error = new AppError('RESOURCE_NOT_FOUND', 'The requested backend does not exist.', {
      details: { backendId: 'abc' },
      cause: new Error('SQLITE_ERROR: no such table: backends'),
      requestId: 'req-1',
    });

    expect(error.toEnvelope()).toEqual({
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'The requested backend does not exist.',
        requestId: 'req-1',
      },
    });
  });

  it('never puts details, cause or stack in the envelope', () => {
    const error = new AppError('DATABASE_ERROR', 'The database operation failed.', {
      details: { path: '/home/someone/data/gateway.db' },
      cause: new Error('/home/someone/data/gateway.db is locked'),
    });

    const serialized = JSON.stringify(error.toEnvelope());
    expect(serialized).not.toMatch(/\/home\/someone/);
    expect(serialized).not.toMatch(/locked/);
    expect(serialized).not.toMatch(/stack/i);
  });

  it('omits requestId when it is unknown', () => {
    expect(new AppError('VALIDATION_ERROR', 'Bad input.').toEnvelope()).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Bad input.' },
    });
  });

  it('maps to a JSON-RPC error object', () => {
    expect(new AppError('VALIDATION_ERROR', 'Invalid params.').toJSONRpcError()).toEqual({
      code: -32602,
      message: 'Invalid params.',
    });
  });

  it('survives JSON.stringify as an envelope, not as an Error', () => {
    const error = new AppError('BACKEND_TIMEOUT', 'The backend timed out.');
    expect(JSON.parse(JSON.stringify(error.toEnvelope()))).toEqual({
      error: { code: 'BACKEND_TIMEOUT', message: 'The backend timed out.' },
    });
  });
});

describe('toAppError', () => {
  it('passes an AppError through untouched', () => {
    const original = new AppError('RESOURCE_CONFLICT', 'Already exists.');
    expect(toAppError(original)).toBe(original);
  });

  it('collapses a raw error into a generic INTERNAL_ERROR', () => {
    // The classic leak: a SQLite or OS message with a path and schema detail.
    const raw = new Error('SQLITE_CANTOPEN: unable to open database file /var/lib/gateway.db');
    const mapped = toAppError(raw);

    expect(mapped.code).toBe('INTERNAL_ERROR');
    expect(mapped.message).toBe('An internal gateway error occurred.');
    expect(mapped.message).not.toMatch(/SQLITE|\/var\/lib/);
    // The original is preserved for logging, not for the client.
    expect(mapped.cause).toBe(raw);
  });

  it('collapses unknown thrown values', () => {
    for (const value of ['a string', 42, null, undefined, { message: 'not an error' }]) {
      const mapped = toAppError(value);
      expect(mapped.code).toBe('INTERNAL_ERROR');
      expect(mapped.message).toBe('An internal gateway error occurred.');
    }
  });

  it('honours an explicit fallback code', () => {
    const mapped = toAppError(new Error('boom'), { code: 'DATABASE_ERROR', message: 'The database operation failed.' });
    expect(mapped.toEnvelope()).toEqual({
      error: { code: 'DATABASE_ERROR', message: 'The database operation failed.' },
    });
  });
});

describe('logging view', () => {
  it('keeps the cause chain and details for logs', () => {
    const error = new AppError('BACKEND_CONNECTION_ERROR', 'Could not reach the backend.', {
      details: { backendId: 'b1' },
      cause: new Error('ECONNREFUSED 127.0.0.1:9000'),
    });

    const described = describeErrorForLog(error);
    expect(described.code).toBe('BACKEND_CONNECTION_ERROR');
    expect(described.details).toEqual({ backendId: 'b1' });
    expect(described.cause).toBe('ECONNREFUSED 127.0.0.1:9000');
    expect(described.stack).toContain('AppError');
  });

  it('describes non-AppError values without throwing', () => {
    expect(describeErrorForLog(new Error('plain')).code).toBe('INTERNAL_ERROR');
    expect(describeErrorForLog('just a string')).toEqual({ code: 'INTERNAL_ERROR', message: 'just a string' });
    expect(describeErrorForLog(undefined).message).toBe('undefined');
  });
});

describe('client vs gateway fault', () => {
  it('treats validation, not-found and conflict as client faults', () => {
    for (const code of ['VALIDATION_ERROR', 'RESOURCE_NOT_FOUND', 'RESOURCE_CONFLICT', 'MCP_PROTOCOL_ERROR'] as const) {
      expect(isClientFault(new AppError(code, 'x'))).toBe(true);
    }
  });

  it('does not treat internal or backend failures as client faults', () => {
    for (const code of ['INTERNAL_ERROR', 'DATABASE_ERROR', 'BACKEND_TIMEOUT', 'CONFIGURATION_ERROR'] as const) {
      expect(isClientFault(new AppError(code, 'x'))).toBe(false);
    }
  });

  it('does not treat an unknown error as a client fault', () => {
    expect(isClientFault(new Error('x'))).toBe(false);
    expect(isClientFault('x')).toBe(false);
  });
});
