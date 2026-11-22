import type { NextRequest } from 'next/server';

import { forwardWrite } from '@/lib/api/write-proxy';

/**
 * Same-origin proxy for session termination.
 *
 * The forwarding lives in `lib/api/write-proxy.ts` and the perimeter in
 * `lib/api/write-policy.ts`; this file only declares the verb. The single
 * allowed target is `POST /api/v1/sessions/:id/terminate` — a UUID-anchored
 * pattern, so no other session path (in particular the cleanup sweep) is
 * expressible from the browser.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return forwardWrite(request, context, 'POST', 'sessions');
}
