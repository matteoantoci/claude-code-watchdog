import { describe, expect, test } from 'claude-code/testing';
import { BAND_SURFACES, bandTarget, stubEngineBand } from './fixtures/band';
import { REVIEW_SPAWN, sendNote, stubDelivery } from './fixtures/delivery';
import { DESKTOP_START, stubState } from './fixtures/on-state';
import type { OnEvents } from '../hooks/on';
import type { DeliveryEvents } from './fixtures/delivery';
import type { RenderSurface } from 'claude-code';
import type { Engine } from 'claude-code/testing';

type Stubs = OnEvents<DeliveryEvents | 'state.get' | 'state.set' | 'ui.render' | 'session.surfaces'>;

const CONCERN = 'parseDate drops the timezone';

// §14.6: a reload starts a new module instance with the `$.state` the old one wrote; `/watchdog on` turned it on.
// §5.3: the reload's `session.start` has `isInteractive` false on the Desktop as in a `-p` run; only
// `$.session.surfaces()` tells them apart.
const reload = async ($: Engine, on: Stubs, surfaces: readonly RenderSurface[]) => {
  const seen = stubDelivery(on);
  stubState(on, { state: { isOn: true, source: '/watchdog on' } });
  stubEngineBand(on);
  on('session.surfaces', () => ({ value: surfaces }));
  await $.session.start(DESKTOP_START);
  await $.agent.spawn(REVIEW_SPAWN);
  return seen;
};

// The first card row of the band on each surface that raises it; undefined where no card is drawn.
const firstCards = async ($: Engine): Promise<(string | undefined)[]> =>
  Promise.all(
    BAND_SURFACES.map(async (surface) => {
      const ui = await $.ui.mount(bandTarget(surface));
      const card = (await ui.find({ key: 'watchdog-card-0' }))?.text;
      await ui.unmount();
      return card;
    })
  );

describe('a reload on the Desktop (§5.3, §14.6)', () => {
  test('the desktop among the surfaces keeps the session interactive: a late concern is nudged and drawn as a card', async ($, on: Stubs) => {
    const seen = await reload($, on, ['desktop']);
    await sendNote($, 'concern', CONCERN);
    expect(seen.logs.at(-1)).toBe(`[concern] default: ${CONCERN} (nudge pending)`);
    expect(await firstCards($)).toEqual(
      BAND_SURFACES.map(() => `▸ CONCERN  default · ${CONCERN} · just now · nudge pending`)
    );
  });

  test('no surface is a -p run: a late concern waits as an aside on the next prompt and no card is drawn', async ($, on: Stubs) => {
    const seen = await reload($, on, []);
    await sendNote($, 'concern', CONCERN);
    expect(seen.logs.at(-1)).toBe(`[concern] default: ${CONCERN} (aside on next prompt)`);
    expect(await firstCards($)).toEqual(BAND_SURFACES.map(() => undefined));
  });
});
