import { describe, expect, it } from 'vitest';

import { findActiveItem, isActive } from '@/lib/navigation';

/**
 * Sidebar selection.
 *
 * "Overview" lives at `/dashboard`, which prefixes every other destination, so
 * a plain prefix test marked it current on every page — two items carrying
 * `aria-current="page"` at once. These cases pin the root item to its own page.
 */

describe('isActive', () => {
  it('marks the root item current only on the root page', () => {
    expect(isActive('/dashboard', '/dashboard')).toBe(true);
    expect(isActive('/dashboard/backends', '/dashboard')).toBe(false);
    expect(isActive('/dashboard/settings', '/dashboard')).toBe(false);
  });

  it('marks the section item current on its own page and its descendants', () => {
    expect(isActive('/dashboard/backends', '/dashboard/backends')).toBe(true);
    expect(isActive('/dashboard/backends/new', '/dashboard/backends')).toBe(true);
    expect(isActive('/dashboard/backends', '/dashboard/settings')).toBe(false);
  });

  it('never marks two items for the same path', () => {
    for (const path of ['/dashboard', '/dashboard/backends/new', '/dashboard/policies/abc', '/login']) {
      const active = ['/dashboard', '/dashboard/backends', '/dashboard/policies'].filter((href) =>
        isActive(path, href),
      );
      expect(active.length, path).toBeLessThanOrEqual(1);
    }
  });
});

describe('findActiveItem', () => {
  it('prefers the longest match, so a subpage names its own section', () => {
    expect(findActiveItem('/dashboard/backends/new')?.href).toBe('/dashboard/backends');
    expect(findActiveItem('/dashboard')?.href).toBe('/dashboard');
  });

  it('falls back to the root item for an unknown subpage and to nothing outside the dashboard', () => {
    expect(findActiveItem('/dashboard/not-a-page')?.href).toBe('/dashboard');
    expect(findActiveItem('/login')).toBeUndefined();
  });
});
