/**
 * Identity the gateway advertises on every MCP exchange and every API response.
 *
 * Declared in lockstep with `package.json` — `tests/version.test.ts` fails the
 * suite if the two ever drift apart. 0.x on purpose: the 1.0.0 this replaced
 * was a placeholder, not an API-stability promise.
 */
export const SERVICE_INFO = { name: 'universal-mcp-gateway', version: '0.18.0' } as const;
