import { NextResponse, type NextRequest } from 'next/server';

/**
 * Passes the requested path to the server tree.
 *
 * This makes **no authentication decision**. The gateway enforces the boundary
 * on every request; the protected layout asks it whether the session is live
 * and, when it is not, needs to know which page the operator was trying to
 * reach so sign-in can return them there. A layout cannot read the pathname, so
 * it travels as a request header — the technique Next documents for exactly
 * this purpose.
 *
 * Named `proxy.ts`, not `middleware.ts`: the file convention was renamed in
 * Next 16 and `middleware` is deprecated.
 */
export function proxy(request: NextRequest): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', request.nextUrl.pathname);

  return NextResponse.next({ request: { headers: requestHeaders } });
}

/** Only the protected tree; the login page and route handlers need nothing. */
export const config = { matcher: ['/dashboard/:path*'] };
