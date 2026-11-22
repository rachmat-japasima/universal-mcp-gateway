'use client';

import { Button, type ButtonVariant } from '@astryxdesign/core/Button';
import Link from 'next/link';

/**
 * `Button as={Link}` for Server Components. The Astryx `as` prop takes a
 * component function, which React cannot serialize across the RSC boundary —
 * a server page rendering `<Button as={Link}>` crashes with "Functions cannot
 * be passed directly to Client Components". This wrapper takes only strings,
 * so server pages can render it directly; the `Link` stays on the client side
 * of the boundary and navigation stays client-side, exactly like the
 * `as={Link}` usages inside client components.
 */
export function LinkButton({
  label,
  href,
  variant,
}: {
  label: string;
  href: string;
  variant?: ButtonVariant;
}) {
  return <Button label={label} href={href} as={Link} variant={variant} />;
}
