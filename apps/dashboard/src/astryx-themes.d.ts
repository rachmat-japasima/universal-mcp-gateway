import type { DefinedTheme } from '@astryxdesign/core/theme';

/**
 * Types for `astryx-themes.js`, which `astryx theme add neutral` generates.
 *
 * The generated file stays `.js` on purpose: the CLI rewrites it whenever the
 * theme set changes, and hand-converting it to `.ts` would be undone on the next
 * `astryx theme` run. `allowJs` is off, so this declaration is what the compiler
 * sees.
 *
 * The keys are the literal theme slugs rather than `Record<string, …>`: the
 * default slug is a literal too, so `themes[defaultThemeSlug]` is a
 * `DefinedTheme` rather than `DefinedTheme | undefined` under
 * `noUncheckedIndexedAccess`. Re-run `astryx theme add <slug>` and this file
 * needs the new key — a stale key here fails typecheck instead of failing at
 * runtime.
 */
export declare const themes: Record<'neutral', DefinedTheme>;
export declare const defaultThemeSlug: 'neutral';
