import type { Metadata } from 'next';

import { PlaceholderScreen, placeholderMetadata } from '@/features/placeholder/placeholder-screen';

const HREF = '/dashboard/agents';

export const metadata: Metadata = placeholderMetadata(HREF);

export default async function Page({ params }: { params: Promise<{ agentId: string }> }): Promise<React.ReactElement> {
  await params;
  return <PlaceholderScreen href={HREF} />;
}
