import type { NextRequest } from 'next/server';

import { forwardWrite } from '@/lib/api/write-proxy';

/**
 * Same-origin proxy for access-policy writes.
 *
 * Three verbs, no logic: the forwarding lives in `lib/api/write-proxy.ts` and the
 * perimeter — which policy paths may be written at all — in
 * `lib/api/write-policy.ts`, where it is unit-tested without a request.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  return forwardWrite(request, context, 'POST', 'policies');
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  return forwardWrite(request, context, 'PATCH', 'policies');
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  return forwardWrite(request, context, 'DELETE', 'policies');
}
