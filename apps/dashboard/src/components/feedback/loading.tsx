import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Grid } from '@astryxdesign/core/Grid';
import { VStack } from '@astryxdesign/core/VStack';

/**
 * Skeleton placeholders shaped like the content they replace, so the layout does
 * not jump when data arrives. `Skeleton` has no accessible name; the wrapper
 * carries a `status` region with a text label for screen readers instead.
 */
export function OverviewSkeleton(): React.ReactElement {
  return (
    <div role="status" aria-label="Loading overview">
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
