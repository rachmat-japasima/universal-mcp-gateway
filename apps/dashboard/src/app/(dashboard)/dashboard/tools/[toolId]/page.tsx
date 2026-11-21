import { Card } from '@astryxdesign/core/Card';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader, SectionBlock } from '@/components/layout/page-container';
import { StatusBadge } from '@/components/ui/status-badge';
import { DetailRow } from '@/components/ui/metric-card';
import { getBackend } from '@/lib/api/backends';
import { getTool } from '@/lib/api/tools';
import { isApiError } from '@/lib/api/errors';
import type { Backend, Tool } from '@/lib/api/types';
import { availabilityStatus, formatTimestamp } from '@/lib/utils/status';
import { AvailabilityBadge } from '@/features/tools/tool-status';
import { ToolRefresh } from '@/features/tools/tool-refresh';

export const metadata: Metadata = { title: 'Tool' };

export const dynamic = 'force-dynamic';

/**
 * One tool, by public name.
 *
 * The route parameter is the **public** name (`<backend_id>__<original>`), which
 * is the key `GET /api/v1/tools/:publicName` addresses. A public name is not an
 * id and may contain characters a path would otherwise treat specially, so the
 * page decodes it and the client encodes it again when building the URL.
 *
 * Schemas are rendered as inert text. `CodeBlock` is a read-only presenter: it
 * takes a string, tokenizes it, and returns DOM it built itself. Nothing here
 * parses the schema as HTML, injects it into the page, or evaluates it, because
 * an `inputSchema` is attacker-influenced data from a remote backend.
 *
 * There is no invocation console, and that is a property of the gateway, not an
 * omission: tool calls happen over `/mcp` under an agent's credential and policy,
 * and no REST call endpoint exists to bind a button to.
 */

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}

export default async function Page({
  params,
}: {
  params: Promise<{ toolId: string }>;
}): Promise<React.ReactElement> {
  const publicName = decodeURIComponent((await params).toolId);

  let tool: Tool;
  try {
    tool = await getTool(publicName);
  } catch (error) {
    // A 404 is the gateway saying this name is not in the catalog: genuinely not
    // found. Anything else is a read failure and must not be dressed as one.
    if (isApiError(error) && error.status === 404) notFound();
    return (
      <PageContainer>
        <ErrorState error={error} title="This tool could not be read" />
      </PageContainer>
    );
  }

  // The owning backend's name and enablement explain availability. A failed read
  // only costs the link label, so it must not fail the page.
  const backend: Backend | undefined = await getBackend(tool.backendId).catch(() => undefined);

  return (
    <PageContainer>
      <VStack gap={6}>
        <PageHeader
          title={tool.title ?? tool.publicName}
          description={tool.description ?? 'This tool has no description.'}
          actions={
            <HStack gap={2} wrap="wrap">
              <ToolRefresh backendId={tool.backendId} label="Rediscover backend" />
            </HStack>
          }
        />

        <SectionBlock title="Identity">
          <Card padding={4}>
            <VStack gap={2}>
              <DetailRow label="Public name" value={<Text type="code">{tool.publicName}</Text>} />
              <DetailRow label="Original name" value={<Text type="code">{tool.originalName}</Text>} />
              <DetailRow
                label="Backend"
                value={
                  backend === undefined ? (
                    <Text type="code">{tool.backendId}</Text>
                  ) : (
                    <a href={`/dashboard/backends/${backend.id}`} className="underline">
                      {backend.name}
                    </a>
                  )
                }
              />
              <DetailRow label="Availability" value={<AvailabilityBadge availability={tool.availability} />} />
              {tool.unavailableReason === undefined ? null : (
                <DetailRow label="Why withheld" value={tool.unavailableReason} />
              )}
              <DetailRow label="Discovered" value={formatTimestamp(tool.discoveredAt)} />
              <DetailRow label="Updated" value={formatTimestamp(tool.updatedAt)} />
              {backend === undefined || backend.enabled ? null : (
                <Text type="supporting" as="p">
                  The owning backend is disabled. Tool access is a system restriction the policy engine applies before
                  any rule, so no policy can grant access while it stays disabled.
                </Text>
              )}
            </VStack>
          </Card>
        </SectionBlock>

        {tool.availability === 'available' ? null : (
          <SectionBlock title="Routing">
            <Card padding={4}>
              <HStack gap={2} align="center" wrap="wrap">
                <StatusBadge status={availabilityStatus(tool.availability)} />
                <Text type="supporting" as="p">
                  {tool.availability === 'conflict'
                    ? 'Another backend tool resolves to the same public name. The gateway withholds every claimant rather than picking one, so this tool is not listed to any agent.'
                    : 'The gateway will not route calls to this tool. Agents do not see it in tools/list.'}
                </Text>
              </HStack>
            </Card>
          </SectionBlock>
        )}

        <SectionBlock
          title="Input schema"
          description="Forwarded verbatim from the backend. Shown as text: the dashboard never parses or executes a backend schema."
        >
          <CodeBlock
            code={pretty(tool.inputSchema)}
            language="json"
            title="inputSchema"
            hasCopyButton
            hasLineNumbers
            isCollapsible
            collapsibleThreshold={24}
            maxHeight={520}
            width="100%"
          />
        </SectionBlock>

        {tool.outputSchema === undefined ? null : (
          <SectionBlock title="Output schema" description="Forwarded verbatim from the backend.">
            <CodeBlock
              code={pretty(tool.outputSchema)}
              language="json"
              title="outputSchema"
              hasCopyButton
              isCollapsible
              collapsibleThreshold={24}
              maxHeight={520}
              width="100%"
            />
          </SectionBlock>
        )}

        {tool.annotations === undefined ? null : (
          <SectionBlock
            title="Annotations"
            description="Optional MCP hints the backend supplied. Advisory metadata — the gateway does not act on them."
          >
            <CodeBlock
              code={pretty(tool.annotations)}
              language="json"
              title="annotations"
              hasCopyButton
              maxHeight={320}
              width="100%"
            />
          </SectionBlock>
        )}

        <SectionBlock title="Calling this tool">
          <Card padding={4}>
            <VStack gap={2}>
              <Text type="supporting" as="p">
                Calls are made by an agent over the MCP endpoint, not from this dashboard. There is no REST invocation
                route: the gateway authorises every call against the calling agent&apos;s policy, and a dashboard button
                would have no agent to authorise as.
              </Text>
              <Text type="supporting" as="p">
                To test a call safely, use an agent credential and its assigned policies. Tool access is per agent — see
                Access Policies.
              </Text>
            </VStack>
          </Card>
        </SectionBlock>
      </VStack>
    </PageContainer>
  );
}
