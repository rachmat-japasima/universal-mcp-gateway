import type { ExecuteTool, CredentialResolver } from './connector.js';
import type { IntegrationConnection } from './connection.js';

/**
 * The seam's runtime half (ADR-049): everything the router needs to dispatch a
 * managed tool, and nothing else. Implemented by the integration service; the
 * router depends on this interface so the MCP path never links against
 * persistence or vault code.
 */
export interface IntegrationDispatch {
  connection: IntegrationConnection;
  executeTool: ExecuteTool;
  resolveCredential: CredentialResolver;
  /** Upper bound for one connector operation. */
  timeoutMs: number;
}

export interface IntegrationRuntime {
  /**
   * Resolves a connection id to a dispatchable call, or explains why it is not
   * callable. The router fails closed on every non-dispatch outcome —
   * authorization already happened, so an unavailable connection is a
   * `TOOL_UNAVAILABLE`, not a policy question.
   */
  dispatchable(connectionId: string): { dispatch: IntegrationDispatch } | { unavailable: string };

  /**
   * The connector reported that the stored credential was rejected. Best
   * effort from the call path: the transition is enforced by the domain rules
   * and the call has already failed.
   */
  markReauthorizationRequired(connectionId: string): void;
}
