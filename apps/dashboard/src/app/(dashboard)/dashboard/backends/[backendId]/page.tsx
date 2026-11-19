import type { Metadata } from 'next';

import { PlaceholderScreen, placeholderMetadata } from '@/features/placeholder/placeholder-screen';

const HREF = '/dashboard/backends';

export const metadata: Metadata = placeholderMetadata(HREF);

/**
 * Detail routes are reachable by URL but not navigable yet: the list screen that
 * links here ships in Phase 10. It renders the same honest placeholder rather
 * than a page that pretends to look up a backend.
 */
export default async function Page({ params }: { params: Promise<{ backendId: string }> }): Promise<React.ReactElement> {
  await params;
  return <PlaceholderScreen href={HREF} />;
}
