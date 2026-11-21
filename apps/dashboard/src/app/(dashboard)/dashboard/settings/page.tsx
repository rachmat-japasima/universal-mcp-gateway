import type { Metadata } from 'next';

import { RefreshButton } from '@/components/feedback/refresh-button';
import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { getSettings } from '@/lib/api/endpoints';
import { isApiError } from '@/lib/api/errors';
import { SettingsContent } from '@/features/settings/settings-content';

export const metadata: Metadata = { title: 'Settings' };

export const dynamic = 'force-dynamic';

/**
 * The effective gateway configuration.
 *
 * One read, and a failed one is an error state rather than a page of blanks:
 * a settings screen that silently shows nothing is indistinguishable from a
 * gateway with no settings.
 *
 * Read-only by construction, not by preference: `GET /api/v1/settings` answers
 * `readOnly: true` and `features.settingsMutation: false`, and there is no write
 * route to call. Every value is environment-managed, so the page says where it
 * comes from instead of rendering disabled inputs that imply an editor exists.
 */
export default async function Page(): Promise<React.ReactElement> {
  let content: React.ReactNode;
  try {
    content = <SettingsContent settings={await getSettings()} />;
  } catch (error) {
    if (!isApiError(error)) throw error;
    content = <ErrorState error={error} title="The settings could not be read" />;
  }

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Settings"
          description="The configuration the gateway resolved at startup. Read-only: every value is environment-managed and changed by restarting the gateway, not from here."
          actions={<RefreshButton label="Refresh settings" />}
        />
        {content}
      </div>
    </PageContainer>
  );
}
