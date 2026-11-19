import { headers } from 'next/headers';

import { AppShellLayout } from '@/components/layout/app-shell';
import { requireOperator } from '@/lib/auth/guard';

/**
 * Route group layout for everything under `/dashboard`.
 *
 * The gateway enforces the boundary; this asks it whether the session is live so
 * an expired cookie lands on the sign-in form instead of a wall of 401 error
 * states. `next` carries the page that was asked for, read from the header the
 * middleware attaches, so signing in returns the operator to where they were
 * going.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const pathname = (await headers()).get('x-pathname') ?? '/dashboard';
  const session = await requireOperator(pathname);

  return AppShellLayout({ children, operator: session.operator });
}
