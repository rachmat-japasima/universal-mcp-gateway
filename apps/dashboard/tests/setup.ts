import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Component tests run in jsdom. Astryx components are consumed from the
 * pre-built package, so no StyleX compilation or CSS import is needed here —
 * only DOM cleanup between cases.
 *
 * No `@testing-library/jest-dom`: the assertions these tests need are plain DOM
 * properties plus `vitest`'s own `expect`, so another dependency would buy
 * nothing.
 */
afterEach(() => {
  cleanup();
});
