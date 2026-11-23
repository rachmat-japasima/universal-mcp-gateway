import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MetricCard } from '@/components/ui/metric-card';

/**
 * The regression these tests exist for: the tile rendered its number as an
 * `<h3>`, so screen readers announced "0, heading level 3" while the label
 * ("Backends") never appeared in the heading outline.
 */
describe('MetricCard', () => {
  it('puts the label, not the value, in the heading outline', () => {
    render(<MetricCard label="Backends" value={0} />);

    const headings = screen.getAllByRole('heading');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe('Backends');
    expect(headings[0]?.tagName).toBe('H2');
  });

  it('keeps the unavailable value out of the heading outline', () => {
    render(<MetricCard label="Tools in catalog" value={null} />);

    const headings = screen.getAllByRole('heading');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe('Tools in catalog');
  });
});
