import { redirect } from 'next/navigation';

/**
 * The dashboard has no meaningful landing page of its own: the shell is the
 * product. `/` exists so a bare visit lands somewhere useful.
 */
export default function RootPage(): never {
  redirect('/dashboard');
}
