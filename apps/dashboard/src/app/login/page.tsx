import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { LoginForm } from '@/features/auth/login-form';
import { safeNextPath } from '@/lib/auth/login';
import { getOperatorSession } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * The sign-in screen.
 *
 * Deliberately outside the `(dashboard)` route group: the shell renders a side
 * nav for destinations an anonymous visitor cannot read, and the form needs to
 * be the whole page.
 *
 * Two redirects, both about not wasting the operator's time:
 *   * a live session is sent straight to the destination — there is no reason to
 *     ask for a password again;
 *   * `next` is validated here *and* on the way back, because a crafted link to
 *     this page is the one input an attacker fully controls.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}): Promise<React.ReactElement> {
  const { next } = await searchParams;
  const destination = safeNextPath(next);

  if ((await getOperatorSession()) !== null) redirect(destination);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-12">
      <LoginForm next={destination} />
    </main>
  );
}
