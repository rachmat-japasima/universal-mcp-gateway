/**
 * One read's outcome, kept as data rather than as a thrown error.
 *
 * Every section of the monitoring page is an independent read, and a failed one
 * must degrade its own card without taking the page down. Throwing would force a
 * try/catch per section at the page level; this type makes "this read failed"
 * a value the panel can render, which is also what makes it testable.
 */
export type Read<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Converts a settled promise into a `Read`, so a rejection never escapes. */
export function settled<T>(result: PromiseSettledResult<T>): Read<T> {
  return result.status === 'fulfilled' ? { ok: true, value: result.value } : { ok: false, error: result.reason };
}
