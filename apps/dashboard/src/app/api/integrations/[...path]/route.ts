import type { NextRequest } from 'next/server';

import { forwardWrite } from '@/lib/api/write-proxy';

/**
 * Same-origin proxy for managed-integration writes (ADR-053).
 *
 * Same code as the backend/agent/policy proxies with a different allowlist
 * prefix. POST covers create, credential, test, and the lifecycle actions;
 * DELETE covers removing a connection. PATCH is deliberately not exported:
 * the integrations surface has no PATCH route, so a handler for it would be
 * a dead verb the policy would refuse anyway.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return forwardWrite(request, context, 'POST', 'integrations');
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return forwardWrite(request, context, 'DELETE', 'integrations');
}
