import type { NextRequest } from 'next/server';

import { forwardWrite } from '@/lib/api/write-proxy';

/**
 * Same-origin proxy for agent and credential writes.
 *
 * The forwarding lives in `lib/api/write-proxy.ts` and the perimeter in
 * `lib/api/write-policy.ts`; this file only declares the three verbs. Credential
 * issuing, rotation and revocation are the only routes here that return a raw
 * token, and they return it to this handler as bytes — nothing is logged or
 * reused.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  return forwardWrite(request, context, 'POST', 'agents');
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  return forwardWrite(request, context, 'PATCH', 'agents');
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  return forwardWrite(request, context, 'DELETE', 'agents');
}
