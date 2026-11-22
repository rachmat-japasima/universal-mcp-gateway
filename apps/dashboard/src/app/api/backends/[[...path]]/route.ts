import type { NextRequest } from 'next/server';

import { forwardWrite } from '@/lib/api/write-proxy';

/**
 * Same-origin proxy for backend management writes.
 *
 * The forwarding lives in `lib/api/write-proxy.ts` and the perimeter in
 * `lib/api/write-policy.ts`; this file only declares the three verbs, so the
 * agent and policy proxies (10.3/10.4) are the same code with a different
 * allowlist prefix rather than a second implementation.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  return forwardWrite(request, context, 'POST', 'backends');
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  return forwardWrite(request, context, 'PATCH', 'backends');
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  return forwardWrite(request, context, 'DELETE', 'backends');
}
