import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Grid } from '@astryxdesign/core/Grid';
import { VStack } from '@astryxdesign/core/VStack';

/**
 * Skeleton placeholders shaped like the content they replace, so the layout does
 * not jump when data arrives.
 *
 * `Skeleton` has no accessible name, so the wrapper is a labelled `status` region
 * instead: a screen reader hears "Loading page" once rather than a pile of
 * anonymous boxes.
 */
export function PageSkeleton({ label = 'Loading page' }: { label?: string }): React.ReactElement {
  return (
    <div role="status" aria-label={label}>
      <VStack gap={4}>
        <Grid columns={{ minWidth: 220, max: 4 }} gap={3}>
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} height={104} radius={3} index={index} />
          ))}
        </Grid>
        <Grid columns={{ minWidth: 260, max: 3 }} gap={3}>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} height={168} radius={3} index={index} />
          ))}
        </Grid>
      </VStack>
    </div>
  );
}
