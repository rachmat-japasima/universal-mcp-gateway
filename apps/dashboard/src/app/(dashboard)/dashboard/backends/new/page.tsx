import type { Metadata } from 'next';

import { PlaceholderScreen, placeholderMetadata } from '@/features/placeholder/placeholder-screen';

const HREF = '/dashboard/backends';

export const metadata: Metadata = { ...placeholderMetadata(HREF), title: 'New backend' };

/**
 * The create flow is a Phase 10 screen. It exists as a route so the planned URL
 * structure is real and testable, not so it can pretend to have a form.
 */
export default function Page(): React.ReactElement {
  return <PlaceholderScreen href={HREF} />;
}
