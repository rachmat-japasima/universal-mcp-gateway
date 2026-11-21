import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthorizationService } from '../src/auth/authorization.js';
import { loadConfig } from '../src/config/config.js';
import { evaluateAccess, WILDCARD, type Policy } from '../src/domain/policy.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import { AgentService } from '../src/registry/agent-service.js';
import { BackendService } from '../src/registry/backend-service.js';
import { PolicyService } from '../src/registry/policy-service.js';
import { ToolCatalog, buildTools, detectConflicts } from '../src/routing/catalog.js';
import { testKeys } from './fixtures/auth.js';

/**
 * Authorization: the decision itself, without HTTP or MCP in the way.
 *
 * The precedence rules are asserted against the pure function *and* the service,
 * because a rule that only holds in the pure function is not enforced anywhere.
 */

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);
const NOW = '2026-11-19T12:00:00.000Z';

const BACKEND_A = '11111111-1111-4111-8111-111111111111';
const BACKEND_B = '22222222-2222-4222-8222-222222222222';

let directory: string;
let store: Database;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-authz-'));
  store = openStore({ path: join(directory, 'gateway.db') });
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function policy(name: string, priority: number, rules: Policy['rules'], id = name): Policy {
  return { id, name, priority, rules, createdAt: NOW, updatedAt: NOW };
}

const allow = (target: string, resource: 'tool' | 'backend' = 'tool') => ({ resource, target, effect: 'allow' as const });
const deny = (target: string, resource: 'tool' | 'backend' = 'tool') => ({ resource, target, effect: 'deny' as const });

describe('evaluateAccess', () => {
  it('denies by default when no rule matches', () => {
    const decision = evaluateAccess([], { agentId: 'a', backendId: BACKEND_A, toolId: 'a__echo', now: NOW });

    expect(decision).toMatchObject({ allowed: false, reason: 'default_deny', decisionTimestamp: NOW });
    expect(decision.matchedPolicyId).toBeUndefined();
  });

  it('allows when an explicit allow matches', () => {
    const decision = evaluateAccess([policy('p', 0, [allow('a__echo')])], {
      agentId: 'a',
      backendId: BACKEND_A,
      toolId: 'a__echo',
      now: NOW,
    });

    expect(decision).toMatchObject({ allowed: true, reason: 'explicit_allow', matchedPolicyId: 'p' });
  });

  it('denies when an explicit deny matches even if another rule allows', () => {
    const decision = evaluateAccess(
      [policy('allow-all', 0, [allow(WILDCARD)]), policy('deny-one', 0, [deny('a__echo')])],
      { agentId: 'a', backendId: BACKEND_A, toolId: 'a__echo', now: NOW },
    );

    expect(decision).toMatchObject({ allowed: false, reason: 'explicit_deny' });
  });

  it('lets a higher priority allow beat a lower priority deny, and vice versa', () => {
    const highAllow = evaluateAccess(
      [policy('low-deny', 0, [deny('a__echo')]), policy('high-allow', 10, [allow('a__echo')])],
      { agentId: 'a', backendId: BACKEND_A, toolId: 'a__echo', now: NOW },
    );
    expect(highAllow).toMatchObject({ allowed: true, matchedPolicyId: 'high-allow' });

    const highDeny = evaluateAccess(
      [policy('low-allow', 0, [allow('a__echo')]), policy('high-deny', 10, [deny('a__echo')])],
      { agentId: 'a', backendId: BACKEND_A, toolId: 'a__echo', now: NOW },
    );
    expect(highDeny).toMatchObject({ allowed: false, matchedPolicyId: 'high-deny' });
  });

  it('breaks an exact tie the same way regardless of input order', () => {
    const first = policy('aaa', 0, [allow(WILDCARD)], 'aaa');
    const second = policy('zzz', 0, [deny(WILDCARD)], 'zzz');

    const forward = evaluateAccess([first, second], { agentId: 'a', toolId: 'x', now: NOW });
    const reverse = evaluateAccess([second, first], { agentId: 'a', toolId: 'x', now: NOW });

    expect(forward.allowed).toBe(reverse.allowed);
    expect(forward.matchedPolicyId).toBe(reverse.matchedPolicyId);
  });

  it('matches backend rules by backend id and tool rules by public name', () => {
    const grant = policy('backend-grant', 0, [allow(BACKEND_A, 'backend')]);

    expect(
      evaluateAccess([grant], { agentId: 'a', backendId: BACKEND_A, toolId: 'a__anything', now: NOW }).allowed,
    ).toBe(true);
    expect(
      evaluateAccess([grant], { agentId: 'a', backendId: BACKEND_B, toolId: 'b__anything', now: NOW }).allowed,
    ).toBe(false);
  });

  it('does not match a tool rule when the query has no tool id, or a backend rule with no backend id', () => {
    const toolGrant = [policy('t', 0, [allow('a__echo')])];
    const backendGrant = [policy('b', 0, [allow(BACKEND_A, 'backend')])];

    expect(evaluateAccess(toolGrant, { agentId: 'a', backendId: BACKEND_A, now: NOW }).allowed).toBe(false);
    expect(evaluateAccess(backendGrant, { agentId: 'a', toolId: 'a__echo', now: NOW }).allowed).toBe(false);
  });
});

function setup() {
  const agents = new AgentService(store);
  const policies = new PolicyService({ store });
  const backends = new BackendService(store);
  const catalog = new ToolCatalog();
  const authorization = new AuthorizationService({ store, catalog, logger, now: () => NOW });

  const backend = backends.create({
    name: 'backend-a',
    connection: { type: 'stdio', command: 'node' },
  });

  const { tools } = buildTools({
    backendId: backend.id,
    now: NOW,
    tools: [
      { name: 'echo', inputSchema: { type: 'object' } },
      { name: 'write', inputSchema: { type: 'object' } },
    ],
    rejected: [],
  });

  catalog.replace({
    sourceType: 'mcp_backend',
    sourceId: backend.id,
    tools,
    report: {
      backendId: backend.id,
      status: 'ok',
      toolCount: tools.size,
      conflictCount: 0,
      rejectedCount: 0,
      discoveredAt: NOW,
    },
  });

  return { agents, policies, backends, catalog, authorization, backend };
}

describe('AuthorizationService', () => {
  it('cannot see or call anything without a policy', () => {
    const { agents, authorization } = setup();
    const agent = agents.create({ name: 'unconfigured' });

    expect(authorization.visibleTools(agent)).toEqual([]);
    expect(authorization.evaluate(agent, { toolId: 'backend-a__echo' })).toMatchObject({
      allowed: false,
      reason: 'default_deny',
    });
  });

  it('sees exactly the tools it may call', () => {
    const { agents, policies, authorization, backend } = setup();
    const agent = agents.create({ name: 'reader' });
    const grant = policies.create({ name: 'read-only', rules: [allow(`${backend.id}__echo`)] });
    policies.assign(agent.id, grant.id);

    const visible = authorization.visibleTools(agent).map((tool) => tool.publicName);
    expect(visible).toEqual([`${backend.id}__echo`]);
    expect(authorization.evaluate(agent, { toolId: `${backend.id}__write` }).allowed).toBe(false);
  });

  it('treats a disabled agent as a system restriction no policy can override', () => {
    const { agents, policies, authorization, backend } = setup();
    const agent = agents.create({ name: 'suspended' });
    const grant = policies.create({ name: 'everything', rules: [allow(WILDCARD)] });
    policies.assign(agent.id, grant.id);

    agents.setEnabled(agent.id, false);
    const disabled = agents.get(agent.id);

    expect(authorization.evaluate(disabled, { toolId: `${backend.id}__echo` })).toMatchObject({
      allowed: false,
      reason: 'agent_disabled',
    });
    expect(authorization.visibleTools(disabled)).toEqual([]);
  });

  it('treats a disabled backend as a system restriction even with a tool-level allow', () => {
    const { agents, policies, authorization, backends, backend } = setup();
    const agent = agents.create({ name: 'reader' });
    const grant = policies.create({ name: 'tools', rules: [allow(WILDCARD)] });
    policies.assign(agent.id, grant.id);

    backends.update(backend.id, { enabled: false });

    expect(
      authorization.evaluate(agent, { backendId: backend.id, toolId: `${backend.id}__echo` }),
    ).toMatchObject({ allowed: false, reason: 'backend_disabled' });
    expect(authorization.visibleTools(agent)).toEqual([]);
  });

  it('audits a denial with the agent, backend, tool, reason, and correlation id', () => {
    const { agents, policies, authorization, backend } = setup();
    const agent = agents.create({ name: 'denied' });
    const grant = policies.create({ name: 'read-only', rules: [allow(`${backend.id}__echo`)] });
    policies.assign(agent.id, grant.id);

    const decision = authorization.evaluate(agent, { backendId: backend.id, toolId: `${backend.id}__write` });
    authorization.safeAudit(decision, { requestId: 'req-42', credentialId: 'cred-1' });

    const denied = store.audit.list(20).find((event) => event.action === 'access.denied');
    expect(denied).toMatchObject({
      actorType: 'agent',
      actorId: agent.id,
      result: 'denied',
      requestId: 'req-42',
      // The target is the backend, never the tool labelled as an agent.
      targetType: 'backend',
      targetId: backend.id,
    });
    expect(denied?.metadata).toMatchObject({
      // No rule matches `write` at all, so the reason is the structural default —
      // a denial caused by an explicit rule would say `explicit_deny`.
      reason: 'default_deny',
      backendId: backend.id,
      toolId: `${backend.id}__write`,
      credentialId: 'cred-1',
    });
    // Nothing matched, so there is no policy to name: a denial must not invent one.
    expect(denied?.metadata).not.toHaveProperty('matchedPolicyId');
    expect(denied?.createdAt).toBe(NOW);
  });

  it('audits nothing for an allowed decision', () => {
    const { agents, policies, authorization, backend } = setup();
    const agent = agents.create({ name: 'reader' });
    const grant = policies.create({ name: 'allow', rules: [allow(WILDCARD)] });
    policies.assign(agent.id, grant.id);

    const decision = authorization.evaluate(agent, { toolId: `${backend.id}__echo` });
    authorization.safeAudit(decision, {});

    expect(store.audit.list(20).filter((event) => event.action === 'access.denied')).toEqual([]);
  });

  it('resolves an unknown name to just the tool id, without inventing a backend', () => {
    const { authorization } = setup();
    expect(authorization.resolveTarget('ghost__tool')).toEqual({ toolId: 'ghost__tool' });
  });

  it('describes an agent access for the management preview', () => {
    const { agents, policies, authorization, backend } = setup();
    const agent = agents.create({ name: 'reader' });
    const grant = policies.create({ name: 'read-only', rules: [allow(`${backend.id}__echo`)] });
    policies.assign(agent.id, grant.id);

    const described = authorization.describeAccess(agent);
    expect(described.policies).toEqual([{ id: grant.id, name: 'read-only', priority: 0 }]);
    expect(described.visibleTools).toEqual([
      {
        publicName: `${backend.id}__echo`,
        sourceType: 'mcp_backend',
        sourceId: backend.id,
        backendId: backend.id,
        allowed: true,
        reason: 'explicit_allow',
      },
      {
        publicName: `${backend.id}__write`,
        sourceType: 'mcp_backend',
        sourceId: backend.id,
        backendId: backend.id,
        allowed: false,
        reason: 'default_deny',
      },
    ]);
  });
});

describe('policy validation', () => {
  const policies = () => new PolicyService({ store });

  it('rejects a rule naming a backend that does not exist', () => {
    expect(() => policies().create({ name: 'typo', rules: [allow(BACKEND_A, 'backend')] })).toThrow(
      /backend that does not exist/,
    );
  });

  it('accepts a tool rule for a tool that is not currently in the catalog', () => {
    // The catalog is transient (ADR-038): a policy must be authorable while the
    // backend is disconnected.
    const created = policies().create({ name: 'future', rules: [allow('some-backend__some_tool')] });
    expect(created.rules).toHaveLength(1);
  });

  it('rejects a malformed public tool name', () => {
    expect(() => policies().create({ name: 'bad', rules: [allow('not a tool name')] })).toThrow(/well-formed/);
  });

  it('accepts a wildcard target without consulting the registry', () => {
    expect(policies().create({ name: 'all', rules: [allow(WILDCARD)] }).rules[0]?.target).toBe(WILDCARD);
  });

  it('assigns and unassigns idempotently', () => {
    const service = policies();
    const agent = new AgentService(store).create({ name: 'a' });
    const created = service.create({ name: 'p', rules: [allow(WILDCARD)] });

    service.assign(agent.id, created.id);
    service.assign(agent.id, created.id);
    expect(store.policies.listPoliciesForAgent(agent.id)).toHaveLength(1);

    service.unassign(agent.id, created.id);
    expect(store.policies.listPoliciesForAgent(agent.id)).toEqual([]);
    expect(() => service.unassign(agent.id, created.id)).toThrow(/not assigned/);
  });

  it('withdraws every grant immediately when a policy is deleted', () => {
    const service = policies();
    const agent = new AgentService(store).create({ name: 'a' });
    const created = service.create({ name: 'p', rules: [allow(WILDCARD)] });
    service.assign(agent.id, created.id);

    service.remove(created.id);

    expect(store.policies.listPoliciesForAgent(agent.id)).toEqual([]);
    expect(store.policies.findById(created.id)).toBeUndefined();
  });

  it('rejects a duplicate policy name but keeps the rules of the original', () => {
    const service = policies();
    service.create({ name: 'once', rules: [allow('a__b')] });

    expect(() => service.create({ name: 'once', rules: [allow('c__d')] })).toThrow(/already exists/);
  });
});

describe('credential keys are not part of authorization', () => {
  it('needs no credential to evaluate: identity comes from the authenticated agent only', () => {
    // Guards against a future change that makes a policy key off a token prefix
    // or credential id — neither is an authorization input, and neither is
    // reachable from `evaluate`.
    const { agents, policies, authorization, backend } = setup();    const agent = agents.create({ name: 'a' });
    const grant = policies.create({ name: 'p', rules: [allow(WILDCARD)] });
    policies.assign(agent.id, grant.id);

    testKeys(); // no interaction with the decision below
    expect(authorization.evaluate(agent, { toolId: `${backend.id}__echo` }).allowed).toBe(true);
  });
});
