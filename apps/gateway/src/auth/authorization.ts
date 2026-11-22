import { randomUUID } from 'node:crypto';

import type { Agent } from '../domain/agent.js';
import type { AgentCredential } from '../domain/agent-credential.js';
import { isCredentialUsable } from '../domain/agent-credential.js';
import type { AccessDecision } from '../domain/policy.js';
import { evaluateAccess } from '../domain/policy.js';
import type { CatalogTool } from '../domain/tool.js';
import type { Database } from '../infrastructure/database/index.js';
import type { Logger } from '../monitoring/logger.js';
import type { ToolCatalog } from '../routing/catalog.js';
import { describeErrorForLog } from '../shared/errors.js';

/**
 * Authorization.
 *
 * One rule set, used by both `tools/list` and `tools/call`. Listing is a view;
 * calling is the boundary. Both ask this service, so the two can never drift.
 *
 * Order, and it is not negotiable per call site:
 *   1. system restrictions  — agent disabled, backend disabled
 *   2. explicit deny        — beats allow at equal priority
 *   3. explicit allow       — highest priority wins
 *   4. default deny         — no matching rule at all
 *
 * The decision carries the reason for the audit trail. It is internal: an MCP
 * client sees the same `Unknown tool` for every non-allow outcome.
 */

export interface AuthorizationOptions {
  store: Database;
  catalog: ToolCatalog;
  logger: Logger;
  now?: () => string;
}

export class AuthorizationService {
  private readonly store: Database;
  private readonly catalog: ToolCatalog;
  private readonly logger: Logger;
  private readonly now: () => string;

  constructor(options: AuthorizationOptions) {
    this.store = options.store;
    this.catalog = options.catalog;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Evaluates one (agent, backend, tool) triple.
   *
   * `toolId` is the *public* name: that is the identifier a policy rule names,
   * and the only one a client can reference.
   */
  evaluate(agent: Agent, target: { backendId?: string; toolId?: string }): AccessDecision {
    const now = this.now();
    const base = {
      agentId: agent.id,
      ...(target.backendId === undefined ? {} : { backendId: target.backendId }),
      ...(target.toolId === undefined ? {} : { toolId: target.toolId }),
    };
    const denial = (reason: 'agent_disabled' | 'backend_disabled') => ({
      allowed: false as const,
      reason,
      ...base,
      decisionTimestamp: now,
    });

    // A system restriction is answered before any policy is read, so no rule can
    // re-enable a disabled agent.
    if (!agent.enabled) return denial('agent_disabled');

    if (target.backendId !== undefined) {
      const backend = this.store.backends.findById(target.backendId);
      if (backend !== undefined && !backend.enabled) return denial('backend_disabled');
    }

    return evaluateAccess(this.store.policies.listPoliciesForAgent(agent.id), { ...base, now });
  }

  /** The tools one agent may see. Empty when no rule allows anything. */
  visibleTools(agent: Agent): CatalogTool[] {
    return this.catalog.listAvailable().filter((tool) => this.evaluate(agent, toolTarget(tool)).allowed);
  }

  /**
   * Read-only access preview for the management API.
   *
   * Evaluates the *current* catalog, so an empty result most often means "no
   * backend is connected", not "no permission". The policy list is reported
   * separately so an operator can tell those apart.
   */
  describeAccess(agent: Agent): {
    agentId: string;
    policies: Array<{ id: string; name: string; priority: number }>;
    visibleTools: Array<{
      publicName: string;
      sourceType: 'mcp_backend' | 'managed_integration';
      sourceId: string;
      backendId: string;
      allowed: boolean;
      reason: string;
    }>;
  } {
    const tools = this.catalog.listAvailable();

    return {
      agentId: agent.id,
      policies: this.store.policies
        .listPoliciesForAgent(agent.id)
        .map((policy) => ({ id: policy.id, name: policy.name, priority: policy.priority })),
      visibleTools: tools.map((tool) => {
        const decision = this.evaluate(agent, toolTarget(tool));
        return {
          publicName: tool.publicName,
          sourceType: tool.sourceType,
          sourceId: tool.sourceId,
          // Kept for existing consumers: the source id (backend id for MCP).
          backendId: tool.sourceId,
          allowed: decision.allowed,
          reason: decision.reason,
        };
      }),
    };
  }

  /**
   * Records a denial.
   *
   * Separate from authentication failures because it always has an agent id,
   * and bounded for the same reason: a client that loops on a denied tool must
   * not be able to grow the audit table.
   */
  auditDenial(decision: AccessDecision, context: AuditContext): void {
    this.store.audit.append({
      id: randomUUID(),
      actorType: 'agent',
      ...(decision.agentId === undefined ? {} : { actorId: decision.agentId }),
      action: 'access.denied',
      /**
       * The target is the backend when it is known. A tool id is not a target
       * *type* in the audit contract, and the tool name is already in metadata,
       * so a denial about an unresolvable name records no target at all rather
       * than labelling a tool as an agent.
       */
      ...(decision.backendId === undefined
        ? {}
        : { targetType: 'backend' as const, targetId: decision.backendId }),
      result: 'denied',
      ...(context.requestId === undefined ? {} : { requestId: context.requestId.slice(0, 64) }),
      metadata: {
        reason: decision.reason,
        ...(decision.backendId === undefined ? {} : { backendId: decision.backendId }),
        ...(decision.toolId === undefined ? {} : { toolId: decision.toolId }),
        ...(context.credentialId === undefined ? {} : { credentialId: context.credentialId }),
        ...(decision.matchedPolicyId === undefined ? {} : { matchedPolicyId: decision.matchedPolicyId }),
        // Suppressed duplicates are folded into the next written row rather than
        // dropped, so the audit trail never understates an attack.
        ...(context.rateLimit?.suppressed === undefined ? {} : { suppressed: context.rateLimit.suppressed }),
      },
      createdAt: decision.decisionTimestamp,
    });
  }

  /** Best-effort resolution used only for audit metadata; never for a decision. */
  resolveTarget(publicName: string): { backendId?: string; toolId: string } {
    const resolved = this.catalog.resolve(publicName);
    // The source id (backend or connection, ADR-048) under the established
    // audit field name — the same vocabulary `toolTarget` uses.
    if ('tool' in resolved) return { backendId: resolved.tool.sourceId, toolId: resolved.tool.publicName };

    // A conflicted name still has claimants, but exposing which backend claims
    // it would leak topology. The tool id alone is enough to audit.
    return { toolId: publicName };
  }

  /**
   * Placeholder for a credential that was authenticated moments ago.
   *
   * Kept explicit so the audit context for denials always names the credential
   * that was used, without the authorization layer needing the entity.
   */
  static credentialContext(credential: AgentCredential): { credentialId: string } {
    return { credentialId: credential.id };
  }

  /** Logs a decision at debug level only: a denial flood must not fill the log either. */
  logDecision(decision: AccessDecision, publicName: string, requestId?: string): void {
    if (decision.allowed) return;

    this.logger.warn(
      {
        agentId: decision.agentId,
        backendId: decision.backendId,
        tool: publicName,
        reason: decision.reason,
        ...(requestId === undefined ? {} : { requestId }),
      },
      'Tool access denied',
    );
  }

  /** Never let an audit write break a request that was already refused for security reasons. */
  safeAudit(decision: AccessDecision, context: AuditContext): void {
    if (decision.allowed) return;

    try {
      this.auditDenial(decision, context);
    } catch (error) {
      this.logger.warn({ error: describeErrorForLog(error) }, 'Access denial could not be audited');
    }
  }
}

export interface AuditContext {
  requestId?: string;
  credentialId?: string;
  rateLimit?: { suppressed: number };
}

/**
 * The two identifiers a policy rule can name. `backendId` is the tool's
 * *source id* (ADR-048): for MCP tools it is exactly what it always was, the
 * backend id; for managed tools it is the connection id. The policy schema is
 * unchanged — a `backend`-scoped rule matches the calling tool's source, and
 * integration tools additionally participate through `tool`-scoped rules
 * (the documented migration strategy, ADR-052).
 */
export function toolTarget(tool: CatalogTool): { backendId: string; toolId: string } {
  return { backendId: tool.sourceId, toolId: tool.publicName };
}

/** Credential usability is a system restriction too, checked before policy for the same reason. */
export function credentialAllows(credential: AgentCredential, now: Date = new Date()): boolean {
  return isCredentialUsable(credential, now);
}
