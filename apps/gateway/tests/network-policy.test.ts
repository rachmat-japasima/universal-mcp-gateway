import { describe, expect, it } from 'vitest';

import { assertDestination, assertUrlShape, guardedFetch, isRestrictedAddress } from '../src/security/network-policy.js';

const open = { allowPrivateNetwork: true };
const closed = { allowPrivateNetwork: false };

describe('isRestrictedAddress', () => {
  it('rejects every non-public IPv4 range', () => {
    for (const address of [
      '0.0.0.0',
      '127.0.0.1',
      '127.255.255.254',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      '100.64.0.1',
      '169.254.169.254',
      '224.0.0.1',
      '240.0.0.1',
    ]) {
      expect(isRestrictedAddress(address), address).toBe(true);
    }
  });

  it('accepts public IPv4', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '192.169.0.1']) {
      expect(isRestrictedAddress(address), address).toBe(false);
    }
  });

  it('rejects loopback, unique-local, link-local and multicast IPv6', () => {
    for (const address of ['::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1']) {
      expect(isRestrictedAddress(address), address).toBe(true);
    }
  });

  it('accepts public IPv6', () => {
    expect(isRestrictedAddress('2606:4700:4700::1111')).toBe(false);
  });
});

describe('assertUrlShape', () => {
  it('accepts http and https only', () => {
    expect(assertUrlShape('https://example.com/mcp').protocol).toBe('https:');
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com', 'javascript:alert(1)']) {
      expect(() => assertUrlShape(url), url).toThrow(/Only http and https/);
    }
  });

  it('refuses embedded credentials', () => {
    expect(() => assertUrlShape('https://user:pass@example.com/mcp')).toThrow(/must not embed credentials/);
    expect(() => assertUrlShape('https://token@example.com/mcp')).toThrow(/must not embed credentials/);
  });

  it('refuses a non-absolute url', () => {
    expect(() => assertUrlShape('/mcp')).toThrow(/not a valid absolute URL/);
  });
});

describe('assertDestination', () => {
  it('refuses literal loopback, private, and metadata addresses', async () => {
    for (const url of [
      'http://127.0.0.1:8080/mcp',
      'http://10.0.0.5:6379/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:9000/mcp',
    ]) {
      await expect(assertDestination(url, closed), url).rejects.toThrow(/restricted|loopback/i);
    }
  });

  it('refuses localhost by name without trusting DNS', async () => {
    await expect(assertDestination('http://localhost:3000/mcp', closed)).rejects.toThrow(/loopback/);
    await expect(assertDestination('http://api.localhost/mcp', closed)).rejects.toThrow(/loopback/);
  });

  it('allows restricted destinations only when the policy opts in', async () => {
    await expect(assertDestination('http://127.0.0.1:3000/mcp', open)).resolves.toBeInstanceOf(URL);
    await expect(assertDestination('http://10.0.0.5:3000/mcp', open)).resolves.toBeInstanceOf(URL);
    await expect(assertDestination('http://localhost:3000/mcp', open)).resolves.toBeInstanceOf(URL);
  });

  it('never allows metadata or link-local, even when the policy opts in', async () => {
    // The opt-in exists for local fixtures, not as a general SSRF bypass.
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/mcp', 'http://0.0.0.0/']) {
      await expect(assertDestination(url, open), url).rejects.toThrow(/metadata|link-local|loopback/);
    }
  });

  it('reports an unresolvable hostname as unreachable, not as a policy hit', async () => {
    await expect(assertDestination('http://does-not-exist.invalid/mcp', closed)).rejects.toThrow(/could not be resolved/);
  });

  it('applies the same policy to the scheme and credentials when opted in', async () => {
    await expect(assertDestination('http://user:pass@127.0.0.1/mcp', open)).rejects.toThrow(/credentials/);
    await expect(assertDestination('file:///etc/passwd', open)).rejects.toThrow(/Only http and https/);
  });
});

describe('guardedFetch', () => {
  it('blocks the request before it reaches the inner fetch', async () => {
    let called = false;
    const inner: typeof fetch = async () => {
      called = true;
      return new Response('ok');
    };

    await expect(guardedFetch(closed, inner)('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('re-checks on every call, not once per client', async () => {
    // The transport calls this per request, so a destination that becomes
    // restricted later (e.g. a redirect target) cannot be covered by a single
    // connect-time check.
    let calls = 0;
    const inner: typeof fetch = async () => {
      calls += 1;
      return new Response('ok');
    };

    const policyFetch = guardedFetch(closed, inner);
    await expect(policyFetch('http://10.0.0.5/mcp')).rejects.toThrow();
    await expect(policyFetch('http://10.0.0.5/mcp')).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it('forwards an allowed destination', async () => {
    const inner: typeof fetch = async () => new Response('ok');
    const response = await guardedFetch(open, inner)('http://127.0.0.1:8080/mcp');
    expect(await response.text()).toBe('ok');
  });
});
