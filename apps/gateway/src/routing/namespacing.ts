import { createHash } from 'node:crypto';

/**
 * Deterministic public tool names.
 *
 * `<backend_id>__<original_tool_name>` — see ADR-036. The rules here are pure
 * functions with no I/O, because the only thing that must never vary between
 * two runs of the gateway is the name a client already stored in its config.
 *
 * Normalization is *lossy on purpose*: two distinct original names can collapse
 * onto one public name. That is not a bug to work around — the catalog detects
 * the duplicate and withholds both (fail closed), rather than silently letting
 * one backend shadow another.
 */

/** SEP-986 tool-name grammar. Anything outside it breaks clients, so it is the normalization target. */
const FORBIDDEN = /[^A-Za-z0-9._-]/g;

/** SEP-986 maximum. Longer names are rejected by clients, so they are hashed, never truncated blindly. */
export const MAX_TOOL_NAME_LENGTH = 128;

export const NAMESPACE_SEPARATOR = '__';

/** Length of the disambiguating digest appended to an over-long name. */
const DIGEST_LENGTH = 8;

/**
 * Maps an arbitrary string onto the tool-name alphabet.
 *
 * Trims, then replaces every disallowed character with `_`. A UUID id passes
 * through unchanged; a tool called `search items` becomes `search_items`.
 */
export function normalizeSegment(value: string): string {
  return value.trim().replace(FORBIDDEN, '_');
}

/**
 * The public name for one backend tool, or `undefined` when either half
 * normalizes to nothing (there is no name that could represent it).
 *
 * Over-long names are cut to fit and suffixed with `__<8 hex>` of
 * SHA-256(`backendId` NUL `originalName`). The digest is derived from the
 * identity, not from randomness, so the same pair always produces the same
 * name — and two pairs that differ only past the cut still differ.
 */
export function publicToolName(backendId: string, originalName: string): string | undefined {
  const backend = normalizeSegment(backendId);
  const tool = normalizeSegment(originalName);
  if (backend === '' || tool === '') return undefined;

  const full = `${backend}${NAMESPACE_SEPARATOR}${tool}`;
  if (full.length <= MAX_TOOL_NAME_LENGTH) return full;

  const digest = createHash('sha256')
    .update(`${backendId}\u0000${originalName}`)
    .digest('hex')
    .slice(0, DIGEST_LENGTH);

  const suffix = `${NAMESPACE_SEPARATOR}${digest}`;
  return full.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
}
