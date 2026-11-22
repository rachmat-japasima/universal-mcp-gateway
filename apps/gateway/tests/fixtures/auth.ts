import type { CredentialKeys } from '../../src/auth/credential-key.js';
import { CredentialKeys as Keys } from '../../src/auth/credential-key.js';
import type { Database } from '../../src/infrastructure/database/index.js';
import { AgentService } from '../../src/registry/agent-service.js';
import { CredentialService } from '../../src/registry/credential-service.js';
import { PolicyService } from '../../src/registry/policy-service.js';

/**
 * Test-only credential plumbing.
 *
 * Secrets are fixed strings, never generated: a test that relied on a fresh
 * secret each run could not exercise "the same secret still verifies after a
 * restart", which is the property that matters. 32+ characters because that is
 * the documented minimum.
 */

export const TEST_SECRET = 'test-only-credential-secret-0123456789';

export function testKeys(secret: string = TEST_SECRET): CredentialKeys {
  return new Keys({ id: 'v1', secret });
}

export interface TestAgent {
  id: string;
  name: string;
  /** Full header value, ready for `Authorization`. */
  authorization: string;
  credentialId: string;
}

export interface CreateTestAgentOptions {
  name?: string;
  enabled?: boolean;
  /** Tool rules. Omitted means "no policy at all" — the default-deny case. */
  allowTools?: string[];
  denyTools?: string[];
  /** Backend rules, for backend-level grants and system restrictions. */
  allowBackends?: string[];
  priority?: number;
}

/**
 * Creates an agent, a credential, and (optionally) one policy granting access.
 *
 * Goes through the real services rather than raw SQL so a schema or service
 * change breaks the helper instead of silently producing an invalid fixture.
 */
export function createTestAgent(
  store: Database,
  keys: CredentialKeys,
  options: CreateTestAgentOptions = {},
): TestAgent {
  const agents = new AgentService(store);
  const credentials = new CredentialService({ store, keys });
  const policies = new PolicyService({ store });

  const agent = agents.create({
    name: options.name ?? 'test-agent',
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  });

  const rules = [
    ...(options.allowTools ?? []).map((target) => ({ resource: 'tool' as const, target, effect: 'allow' as const })),
    ...(options.allowBackends ?? []).map((target) => ({
      resource: 'backend' as const,
      target,
      effect: 'allow' as const,
    })),
    ...(options.denyTools ?? []).map((target) => ({ resource: 'tool' as const, target, effect: 'deny' as const })),
  ];

  if (rules.length > 0) {
    const policy = policies.create({
      name: `policy-${agent.name}`,
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      rules,
    });
    policies.assign(agent.id, policy.id);
  }

  const { credential, token } = credentials.issue(agent.id, { name: 'test' });
  return {
    id: agent.id,
    name: agent.name,
    credentialId: credential.id,
    authorization: `Bearer ${token}`,
  };
}

/** Header object for `app.request` / `fetch`. */
export function bearer(agent: TestAgent): Record<string, string> {
  return { Authorization: agent.authorization };
}
