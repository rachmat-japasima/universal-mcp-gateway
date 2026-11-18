import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { AppError } from '../shared/errors.js';

/**
 * Outbound destination policy for Streamable HTTP backends.
 *
 * The gateway is a local control plane that can be told to open sockets. That
 * makes it an SSRF primitive unless destinations are constrained: a backend
 * definition pointing at `http://169.254.169.254/` or `http://10.0.0.5:6379/`
 * would otherwise turn an unauthenticated local API into a network scanner.
 *
 * Policy (explicit, and the only one implemented):
 *   * scheme must be http or https — nothing else is dialled;
 *   * embedded credentials (`user:pass@`) are refused: they are logged by
 *     proxies, echoed in errors, and would leak through a redirect;
 *   * loopback, private, CGNAT, link-local, multicast, unspecified, and
 *     metadata addresses are refused by default;
 *   * `allowPrivateNetwork` opens ONLY loopback/private/CGNAT (local fixtures).
 *     Link-local, unspecified, multicast, and reserved ranges stay refused, so
 *     the opt-in can never be used to reach `169.254.169.254`;
 *   * the hostname is RESOLVED and every returned address is checked, so
 *     `http://metadata.google.internal` cannot slip past a string check;
 *   * the check runs on every request through a guarded `fetch`, which is how
 *     redirects are covered: the SDK's default `redirectPolicy: 'same-origin'`
 *     re-enters our fetch per hop and refuses cross-origin hops outright.
 *
 * Deliberate limit (documented, not silently accepted): this is check-then-
 * connect, so a DNS answer that changes between our lookup and the socket
 * (rebinding) is not fully closed. Full pinning needs a custom agent that
 * dials the resolved IP, which this phase does not add. The window requires a
 * hostile DNS server for a hostname the operator configured themselves.
 */

/**
 * Ranges that are never a legitimate "public MCP server" and are never allowed,
 * even with `allowPrivateNetwork`: `.0/8` "this network", link-local (which is
 * where cloud metadata lives), multicast, and reserved.
 */
const ALWAYS_BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 cloud metadata
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

/** Private/CGNAT/loopback: blocked by default, opened by `allowPrivateNetwork`. */
const PRIVATE_V4: ReadonlyArray<readonly [string, number]> = [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
];

function v4ToInt(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = (value << 8) | octet;
  }

  return value >>> 0;
}

function inV4Range(address: string, base: string, bits: number): boolean {
  const value = v4ToInt(address);
  const network = v4ToInt(base);
  if (value === undefined || network === undefined) return false;

  // `>>> 0` keeps the shift in unsigned 32-bit space; bits=0 would be 32.
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (network & mask);
}

/**
 * Loopback/private determination for a literal IP, IPv4 or IPv6.
 *
 * `allowPrivate` opens only the ranges an operator might legitimately own on a
 * LAN. Addresses that are never a real server — link-local (cloud metadata),
 * unspecified, multicast, reserved — stay blocked so the opt-in cannot be used
 * to reach `169.254.169.254`.
 */
export function isRestrictedAddress(address: string, allowPrivate = false): boolean {
  const family = isIP(address);
  if (family === 4) return isV4Restricted(address, allowPrivate);

  if (family === 6) {
    const normalized = address.toLowerCase().split('%')[0] ?? '';

    // IPv4-mapped (`::ffff:127.0.0.1`): judge the embedded v4 address.
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
    if (mapped?.[1] !== undefined) return isV4Restricted(mapped[1], allowPrivate);

    // Unspecified and multicast stay blocked either way.
    if (normalized === '::') return true;
    if (/^ff[0-9a-f]{2}:/.test(normalized)) return true;

    // Loopback and link-local (which includes fe80:: metadata endpoints).
    if (normalized === '::1') return !allowPrivate;
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
    // fc00::/7 unique-local is the IPv6 "private" range.
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return !allowPrivate;

    return false;
  }

  // Not an IP at all: not something this function can vouch for.
  return false;
}

function isV4Restricted(address: string, allowPrivate: boolean): boolean {
  if (ALWAYS_BLOCKED_V4.some(([base, bits]) => inV4Range(address, base, bits))) return true;
  if (PRIVATE_V4.some(([base, bits]) => inV4Range(address, base, bits))) return !allowPrivate;
  return false;
}

export interface DestinationPolicy {
  /** Explicit opt-in for loopback/private destinations (local test fixtures). */
  allowPrivateNetwork: boolean;
}

export function destinationError(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('BACKEND_CONNECTION_ERROR', message, { details });
}

/**
 * Structural URL checks that need no network. Used by `assertDestination` and
 * re-used by the guarded fetch on every hop.
 */
export function assertUrlShape(raw: string | URL): URL {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    throw destinationError('The backend URL is not a valid absolute URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw destinationError('Only http and https destinations are allowed.', { protocol: url.protocol });
  }

  if (url.username !== '' || url.password !== '') {
    throw destinationError('Backend URLs must not embed credentials; use a secret reference header.');
  }

  if (url.hostname === '') throw destinationError('The backend URL has no host.');

  return url;
}

/**
 * Resolves and classifies a destination. Async because the answer must come
 * from the resolver, not from the operator's string.
 */
export async function assertDestination(raw: string | URL, policy: DestinationPolicy): Promise<URL> {
  const url = assertUrlShape(raw);
  const allowPrivate = policy.allowPrivateNetwork;

  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host) !== 0) {
    if (isRestrictedAddress(host, allowPrivate)) {
      throw destinationError('Destination is a loopback, private, link-local, or metadata address.', {
        reason: 'restricted_address',
      });
    }
    return url;
  }

  // `.localhost` is resolved by RFC 6761 resolvers to loopback; treat the name
  // as restricted without asking DNS, which may not answer for it at all.
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
    if (allowPrivate) return url;
    throw destinationError('Destination is a loopback address.', { reason: 'restricted_address' });
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    // No A/AAAA answer: unreachable, not a policy decision.
    throw destinationError('The backend hostname could not be resolved.', { reason: 'unresolvable' });
  }

  if (addresses.length === 0) {
    throw destinationError('The backend hostname resolved to no addresses.', { reason: 'unresolvable' });
  }

  for (const { address } of addresses) {
    if (isRestrictedAddress(address, allowPrivate)) {
      throw destinationError('Destination resolves to a loopback, private, link-local, or metadata address.', {
        reason: 'restricted_address',
      });
    }
  }

  return url;
}

/**
 * `fetch` that applies the destination policy to every request the transport
 * makes, including each redirect hop. Redirect following is left to the SDK's
 * `'same-origin'` policy, so a cross-origin redirect fails before it is dialled.
 */
export function guardedFetch(policy: DestinationPolicy, inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    await assertDestination(url, policy);
    return inner(input, init);
  };
}
