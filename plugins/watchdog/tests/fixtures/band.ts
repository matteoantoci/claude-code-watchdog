// Stubs for an L2 test of the `AbovePrompt` band (spec §13.1): the engine's own band beneath the plugins, and
// the mount targets of the two surfaces that raise the band.
import type { OnEvents } from '../../hooks/on';
import type { MountTarget } from 'claude-code/testing';

// The engine's band: a `ui.render` stub must return a tree element, not a string (kit 2.1.290).
export const ENGINE_BAND = 'engine band';

// §13.1, §16.2: the kit draws `AbovePrompt` on vscode and mobile too; only these two raise it (d.ts 9922).
export const BAND_SURFACES = ['terminal', 'desktop'] as const;

export type BandSurface = (typeof BAND_SURFACES)[number];

// `bodyColumns` 115 is a terminal of 120 columns (§13.1 width facts).
export const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 115,
  scroll: { bodyRows: 19, offset: 0 },
  view: {},
};

// The props a test changes: `bodyColumns` for the narrow modes, `hasSurvey`.
export type BandProps = Partial<typeof BAND_PROPS>;

export const bandTarget = (surface: BandSurface, props: BandProps = {}): MountTarget<BandSurface, 'AbovePrompt'> => ({
  plugin: 'watchdog',
  surface,
  component: 'AbovePrompt',
  props: { ...BAND_PROPS, ...props },
});

export const stubEngineBand = (on: OnEvents<'ui.render'>): void => {
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ENGINE_BAND }));
};
