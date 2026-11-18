import { randomUUID } from 'node:crypto';

import type { Agent } from '../domain/agent.js';
import type { AgentCredential } from '../domain/agent-credential.js';
import { credentialStatus } from '../domain/agent-credential.js';
import type { AuditAction } from '../domain/audit-event.js';
import type { Database } from '../infrastructure/database/index.js';
import { AppError } from '../shared/errors.js';
import type { CredentialKeys } from '../auth/credential-key.js';
import { issueToken } from '../auth/credential-key.js';
import type { Actor } from './backend-service.js';
import { LOCAL_OPERATOR } from './backend-service.js';

/**
 * Agent credential lifecycle.
 *
 * A raw token leaves this module exactly once — in the return value of
 * `issue`/`rotate` — and is never stored, logged, or readable again. Everything
 * that can be listed is either public metadata or a non-secret display prefix.
 *
 * Rotation is replace-semantics, not overlap: the old credential is revoked in
 * the same transaction that creates the new one, so a caller that lost its token
 * must complete the swap before its next request. That is deliberate — an
 * overlap window would silently keep a compromised credential usable.
 */

export interface IssuedCredential {
  credential: AgentCredential;
  /** Shown once. Never persisted. */
  token: string;
}

export interface CredentialServiceOptions {
  store: Database;
  keys: CredentialKeys;
  actor?: Actor;
  now?: () => string;
}

export class CredentialService {
  private readonly store: Database;
  private readonly keys: CredentialKeys;
  private readonly actor: Actor;
  private readonly now: () => string;

  constructor(options: CredentialServiceOptions) {
    this.store = options.store;
    this.keys = options.keys;
    this.actor = options.actor ?? LOCAL_OPERATOR;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  list(agentId: string): AgentCredential[] {
    this.requireAgent(agentId);
    return this.store.credentials.listByAgentId(agentId);
  }

  /**
   * Issues a credential for an existing agent.
   *
   * Refuses when no hashing secret is configured: issuing a credential that
   * nothing can verify would be a token the operator believes works.
   */
  issue(
    agentId: string,
    input: { name?: string; expiresAt?: string } = {},
  ): IssuedCredential {
    const key = this.keys.issuing;
    if (key === undefined) {
      throw new AppError(
        'CONFIGURATION_ERROR',
        'Credential issuance is unavailable: the server hashing secret is not configured.',
      );
    }

    return this.store.transaction(() => {
      const agent = this.requireAgent(agentId);
      const issued = issueToken(key);
      const now = this.now();

      const credential = this.store.credentials.create(
        {
          agentId: agent.id,
          credentialHash: issued.tokenHash,
          tokenPrefix: issued.tokenPrefix,
          hashKeyId: issued.hashKeyId,
          ...(input.name === undefined ? {} : { label: input.name }),
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        },
        now,
      );

      this.audit('credential.created', 'success', credential, {
        credentialId: credential.id,
        ...(credential.label === undefined ? {} : { name: credential.label }),
      });

      return { credential, token: issued.token };
    });
  }

  /**
   * Replaces a credential: new token, old one revoked atomically.
   *
   * Optional `expiresAt`/`name` are carried over from the old credential when
   * omitted, so a rotation does not quietly extend a credential's life or lose
   * its label.
   */
  rotate(
    agentId: string,
    credentialId: string,
    input: { name?: string; expiresAt?: string } = {},
  ): IssuedCredential {
    const key = this.keys.issuing;
    if (key === undefined) {
      throw new AppError(
        'CONFIGURATION_ERROR',
        'Credential rotation is unavailable: the server hashing secret is not configured.',
      );
    }

    return this.store.transaction(() => {
      const agent = this.requireAgent(agentId);
      const previous = this.requireCredential(agentId, credentialId);

      if (credentialStatus(previous, new Date(this.now())) === 'revoked') {
        throw new AppError('RESOURCE_CONFLICT', 'A revoked credential cannot be rotated. Issue a new one.', {
          details: { credentialId },
        });
      }

      const issued = issueToken(key);
      const now = this.now();

      const created = this.store.credentials.create(
        {
          agentId: agent.id,
          credentialHash: issued.tokenHash,
          tokenPrefix: issued.tokenPrefix,
          hashKeyId: issued.hashKeyId,
          ...(input.name !== undefined
            ? { label: input.name }
            : previous.label === undefined
              ? {}
              : { label: previous.label }),
          ...(input.expiresAt !== undefined
            ? { expiresAt: input.expiresAt }
            : previous.expiresAt === undefined
              ? {}
              : { expiresAt: previous.expiresAt }),
        },
        now,
      );

      this.store.credentials.revoke(previous.id, now);

      this.audit('credential.rotated', 'success', created, {
        credentialId: created.id,
        previousCredentialId: previous.id,
      });

      return { credential: created, token: issued.token };
    });
  }

  /** Idempotent at the API level: revoking an already-revoked credential returns it unchanged. */
  revoke(agentId: string, credentialId: string): AgentCredential {
    return this.store.transaction(() => {
      this.requireAgent(agentId);
      const existing = this.requireCredential(agentId, credentialId);

      const revoked = this.store.credentials.revoke(existing.id, this.now());

      if (existing.revokedAt === undefined) {
        this.audit('credential.revoked', 'success', revoked, { credentialId: revoked.id });
      }

      return revoked;
    });
  }

  private requireAgent(agentId: string): Agent {
    const agent = this.store.agents.findById(agentId);
    if (agent === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested agent does not exist.', {
        details: { agentId },
      });
    }
    return agent;
  }

  /** Scoped by agent, so an id from another agent's credential is simply not found. */
  private requireCredential(agentId: string, credentialId: string): AgentCredential {
    const credential = this.store.credentials.findById(credentialId);
    if (credential === undefined || credential.agentId !== agentId) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested credential does not exist.', {
        details: { credentialId },
      });
    }
    return credential;
  }

  private audit(
    action: AuditAction,
    result: 'success',
    credential: AgentCredential,
    metadata: Record<string, string | number | boolean>,
  ): void {
    this.store.audit.append({
      id: randomUUID(),
      actorType: this.actor.type,
      ...(this.actor.id === undefined ? {} : { actorId: this.actor.id }),
      action,
      targetType: 'credential',
      targetId: credential.id,
      result,
      metadata,
      createdAt: this.now(),
    });
  }
}

/**
 * Public representation of a credential.
 *
 * The field list is explicit: a verifier is never included, and a future column
 * has to be added here on purpose. `tokenPrefix` is the only token-derived value,
 * and it cannot be used to authenticate.
 */
export function toPublicCredential(credential: AgentCredential, now: Date = new Date()): Record<string, unknown> {
  return {
    id: credential.id,
    agentId: credential.agentId,
    ...(credential.label === undefined ? {} : { name: credential.label }),
    ...(credential.tokenPrefix === undefined ? {} : { tokenPrefix: credential.tokenPrefix }),
    ...(credential.hashKeyId === undefined ? {} : { hashKeyId: credential.hashKeyId }),
    status: credentialStatus(credential, now),
    createdAt: credential.createdAt,
    ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
    ...(credential.lastUsedAt === undefined ? {} : { lastUsedAt: credential.lastUsedAt }),
    ...(credential.revokedAt === undefined ? {} : { revokedAt: credential.revokedAt }),
  };
}
