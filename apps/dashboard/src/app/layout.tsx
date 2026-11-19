import type { Metadata } from 'next';

// First import in the entry point: it declares the cascade-layer order that
// Astryx and Tailwind both depend on (docs: "Other styling libraries").
import './globals.css';

import { DashboardTheme } from '@/components/theme/dashboard-theme';

export const metadata: Metadata = {
  title: {
    default: 'Universal MCP Gateway',
    template: '%s · Universal MCP Gateway',
  },
  description: 'Administration dashboard for the Universal MCP Gateway.',
  // The dashboard is a local operator tool; it must never be indexed.
  robots: { index: false, follow: false },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
} as const;

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <DashboardTheme>{children}</DashboardTheme>
      </body>
    </html>
  );
}
