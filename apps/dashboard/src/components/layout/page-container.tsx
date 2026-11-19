import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

/**
 * The page heading pattern. AppShell owns the main landmark and the skip link
 * but renders no heading, so every page starts with exactly one h1 here.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <VStack gap={1}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Heading level={1}>{title}</Heading>
          {description === undefined ? null : (
            <Text type="supporting" as="p">
              {description}
            </Text>
          )}
        </div>
        {actions === undefined ? null : <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </VStack>
  );
}

/** Consistent vertical rhythm and a reading-width cap for every page body. */
export function PageContainer({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="mx-auto w-full max-w-[1400px] px-4 py-6 md:px-6">{children}</div>;
}

/** Standard section: heading, optional supporting text, content. */
export function SectionBlock({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section aria-label={title}>
      <VStack gap={3}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <Heading level={2}>{title}</Heading>
            {description === undefined ? null : (
              <Text type="supporting" as="p">
                {description}
              </Text>
            )}
          </div>
          {actions === undefined ? null : <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
        {children}
      </VStack>
    </section>
  );
}
