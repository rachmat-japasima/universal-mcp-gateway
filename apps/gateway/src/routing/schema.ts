import { fromJsonSchema } from '@modelcontextprotocol/server';

/**
 * Argument validation against the *backend's* schema, not a reconstruction.
 *
 * `fromJsonSchema` wraps a raw JSON Schema object in the SDK's Standard Schema
 * interface and validates with AJV (dialects 2020-12, 2019-09, draft-07). The
 * schema is never converted, so what the gateway validates against is byte-for-
 * byte what it advertises.
 *
 * Two things this deliberately does NOT do:
 *
 *  - Coerce. AJV is configured without `coerceTypes`/defaults by the SDK
 *    provider, so a valid argument object arrives at the backend unmodified.
 *    Coercion would silently change a caller's data.
 *  - Fail the call when the schema cannot be compiled. A backend may publish a
 *    schema using an unknown dialect or a `$ref` it does not inline. Refusing to
 *    route would be worse than forwarding: the backend is the authority on its
 *    own arguments. Such tools are routed unvalidated and reported by
 *    `unvalidatedReason` so the operator can see it.
 */

export interface ValidationResult {
  valid: boolean;
  message?: string;
}

export interface CompiledSchema {
  /** Absent when the schema could not be compiled; the call is then forwarded as-is. */
  validate?: (args: unknown) => ValidationResult;
  /** Present when the schema could not be compiled. Safe to log; bounded. */
  unvalidatedReason?: string;
}

/**
 * Compilation is cached per schema *object*, so a re-discovery that produces an
 * equal-but-distinct object recompiles once. The cache holds no catalog data —
 * it is a pure function memo, and the catalog record stays plain JSON.
 */
const cache = new WeakMap<object, CompiledSchema>();

export function compileInputSchema(schema: Record<string, unknown>): CompiledSchema {
  const cached = cache.get(schema);
  if (cached !== undefined) return cached;

  const compiled = compile(schema);
  cache.set(schema, compiled);
  return compiled;
}

function compile(schema: Record<string, unknown>): CompiledSchema {
  try {
    // `fromJsonSchema` compiles eagerly: an unresolvable `$ref` or an unknown
    // `$schema` throws here rather than at call time.
    const wrapped = fromJsonSchema(schema as never);
    const validate = (args: unknown): ValidationResult => {
      const result = wrapped['~standard'].validate(args) as
        | { value: unknown; issues?: undefined }
        | { issues: ReadonlyArray<{ message?: string }> };

      if (result.issues === undefined) return { valid: true };

      const message = result.issues
        .slice(0, 5)
        .map((issue) => issue.message ?? 'invalid')
        .join('; ');
      return { valid: false, message: message === '' ? 'the arguments do not match the tool schema' : message };
    };

    return { validate };
  } catch (error) {
    return {
      unvalidatedReason: describeCompileFailure(error),
    };
  }
}

/**
 * The failure text is used in logs and in the management API, so it must not
 * carry anything but the library's own explanation. AJV messages name schema
 * paths and dialects — no caller data is involved, since compilation happens
 * before any arguments exist.
 */
function describeCompileFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Schema could not be compiled; arguments are forwarded without validation (${message.slice(0, 300)})`;
}
