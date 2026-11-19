import type { Metadata } from 'next';

import { PlaceholderScreen, placeholderMetadata } from '@/features/placeholder/placeholder-screen';

const HREF = '/dashboard/backends';

export const metadata: Metadata = placeholderMetadata(HREF);

export default function Page(): React.ReactElement {
  return <PlaceholderScreen href={HREF} />;
}
