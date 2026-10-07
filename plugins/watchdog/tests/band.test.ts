import { describe, expect, test } from 'claude-code/testing';
import { BAND_SURFACES, ENGINE_BAND, bandTarget, stubEngineBand } from './fixtures/band';
import {
  PERSON_PROMPT,
  REVIEW_SPAWN,
  TASK_NOTIFICATION,
  sendNote,
  startReview,
  stubDelivery,
} from './fixtures/delivery';
import { stubState } from './fixtures/on-state';
import { HEADLESS_START, HOME, NOW, START, typed } from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { BandProps, BandSurface } from './fixtures/band';
import type { DeliveryEvents } from './fixtures/delivery';
import type { StateSeed } from './fixtures/on-state';
import type { Engine, Mounted } from 'claude-code/testing';

type Stubs = OnEvents<DeliveryEvents | 'state.get' | 'state.set' | 'ui.render'>;

const OLD_CONCERN = 'parseDate drops the timezone; the test at date.spec.ts:40 only passes in UTC.';
const NIT = '.env.example still lists STRIPE_SECRET; config.ts reads STRIPE_SECRET_KEY.';
const BLOCKER = 'The migration deletes the users table before it copies the rows.';
const NEW_CONCERN = 'The new /export route skips requireAuth; every other admin route has it.';

// §13.1: notes of 3 rows each as Markdown, a line and a list of 2 items. With a nit, 3 cards and `+N more` take
// 17 rows: the count line, 3 headers and `+N more`, 3 blank rows and 3 bodies.
const LISTED_BLOCKER =
  'The migration loses the users\n- `up()` drops `users` at line 12\n- the copy reads `users` at line 30';
const LISTED_NEW = 'The new /export route is open\n- it skips `requireAuth`\n- every other admin route has it';
const LISTED_OLD = 'parseDate drops the timezone\n- `date.spec.ts:40` passes only in UTC\n- CI runs in UTC';

// The keyed rows of the card list, top to bottom.
const LIST_KEYS = ['watchdog-card-0', 'watchdog-card-1', 'watchdog-card-2', 'watchdog-more'];

// The keyed rows of the watchdog's band, top to bottom.
const ROW_KEYS = ['watchdog-band', 'watchdog-off', 'watchdog-count', 'watchdog-trouble', ...LIST_KEYS];

// §13.1: the blank rows above each row of the card list: one between two cards and above `+N more`, or none.
const SPACED = { 'watchdog-card-0': 0, 'watchdog-card-1': 1, 'watchdog-card-2': 1, 'watchdog-more': 1 };
const TIGHT = { 'watchdog-card-0': 0, 'watchdog-card-1': 0, 'watchdog-card-2': 0, 'watchdog-more': 0 };

const stubBand = (on: Stubs, options: Parameters<typeof stubDelivery>[1] = {}, seed: StateSeed = {}): void => {
  stubDelivery(on, options);
  stubState(on, seed);
  stubEngineBand(on);
};

// One review's 4 notes while the session is idle: the concerns and the blocker wait for a nudge, the nit for
// the next person prompt (§10.3, §10.2).
const fourNotes = async ($: Engine): Promise<void> => {
  await sendNote($, 'concern', OLD_CONCERN);
  await sendNote($, 'nit', NIT);
  await sendNote($, 'blocker', BLOCKER);
  await sendNote($, 'concern', NEW_CONCERN);
};

// The 3 listed notes and the nit, sent as `fourNotes` sends its notes.
const listedNotes = async ($: Engine): Promise<void> => {
  await sendNote($, 'concern', LISTED_OLD);
  await sendNote($, 'nit', NIT);
  await sendNote($, 'blocker', LISTED_BLOCKER);
  await sendNote($, 'concern', LISTED_NEW);
};

// §16.2: the kit draws `AbovePrompt` on every surface; each check runs on the two that raise the band.
type BandUi = Mounted<BandSurface, 'AbovePrompt'>;

const onBand = async <T>($: Engine, props: BandProps, read: (ui: BandUi) => Promise<T>): Promise<T[]> =>
  Promise.all(
    BAND_SURFACES.map(async (surface: BandSurface) => {
      const ui = await $.ui.mount(bandTarget(surface, props));
      const value = await read(ui);
      await ui.unmount();
      return value;
    })
  );

// The text of each keyed row the watchdog draws, by key; the outer row is left out, a row not drawn is absent.
const rows = async ($: Engine, props: BandProps = {}): Promise<Record<string, string>[]> =>
  onBand($, props, async (ui) => {
    const found = await Promise.all(ROW_KEYS.map(async (key) => [key, (await ui.find({ key }))?.text] as const));
    return Object.fromEntries(
      found.filter((entry): entry is readonly [string, string] => entry[1] !== undefined && entry[0] !== ROW_KEYS[0])
    );
  });

// The props of the first Text that shows exactly each text.
const textProps = async ($: Engine, texts: readonly RegExp[], props: BandProps = {}) =>
  onBand($, props, async (ui) =>
    Promise.all(texts.map(async (text) => (await ui.find({ type: 'Text', text }))?.props))
  );

// The blank rows above each row of the card list (its `marginTop`), by key; a row not drawn is absent.
const gaps = async ($: Engine, props: BandProps = {}): Promise<Record<string, number>[]> =>
  onBand($, props, async (ui) => {
    const found = await Promise.all(
      LIST_KEYS.map(async (key) => [key, (await ui.find({ key }))?.props['marginTop']] as const)
    );
    return Object.fromEntries(
      found.filter((entry): entry is readonly [string, number] => typeof entry[1] === 'number')
    );
  });

const onBoth = <T>(value: T): T[] => BAND_SURFACES.map(() => value);

describe('band cards (§13.1)', () => {
  test('the count line, then the 3 first notes by severity and newest, a blank row between, then +N more', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    expect(await textProps($, [new RegExp(`^${ENGINE_BAND}$`, 'u')])).toEqual(onBoth([{}]));
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-count': 'watchdog · 1 blocker · 2 concerns · 1 nit',
        'watchdog-card-0': ` BLOCKER  default · just now · nudged${BLOCKER}`,
        'watchdog-card-1': ` CONCERN  default · just now · nudged${NEW_CONCERN}`,
        'watchdog-card-2': ` CONCERN  default · just now · nudged${OLD_CONCERN}`,
        'watchdog-more': '  +1 more: 1 nit',
      })
    );
    expect(await gaps($)).toEqual(onBoth(SPACED));
  });

  test('a badge is a theme-key background with inverseText; the count line colors each severity', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await sendNote($, 'nit', NIT);
    await sendNote($, 'blocker', BLOCKER);
    await sendNote($, 'concern', NEW_CONCERN);
    expect(await textProps($, [/^ BLOCKER $/u, /^ CONCERN $/u, /^ NIT $/u])).toEqual(
      onBoth([
        { backgroundColor: 'error', color: 'inverseText', bold: true },
        { backgroundColor: 'warning', color: 'inverseText', bold: true },
        { backgroundColor: 'inactive', color: 'inverseText', bold: false },
      ])
    );
    expect(await textProps($, [/^1 blocker$/u, /^1 concern$/u, /^1 nit$/u])).toEqual(
      onBoth([
        { color: 'error', bold: true, dimColor: false },
        { color: 'warning', bold: true, dimColor: false },
        { color: 'inactive', bold: false, dimColor: true },
      ])
    );
  });

  test('a card shows its age in turns and the delivery state its note has now', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await sendNote($, 'concern', NEW_CONCERN);
    await $.prompt.submit(TASK_NOTIFICATION);
    await $.turn.start({ text: TASK_NOTIFICATION.text, turnId: 't1' });
    expect((await rows($)).map((shown) => shown['watchdog-card-0'])).toEqual(
      onBoth(` CONCERN  default · 1 turn ago · steered${NEW_CONCERN}`)
    );
  });

  test('a raise moves the card and the count to the higher severity (§9.1)', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await sendNote($, 'concern', BLOCKER);
    await sendNote($, 'blocker', BLOCKER);
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-count': 'watchdog · 1 blocker',
        'watchdog-card-0': ` BLOCKER  default · just now · nudged${BLOCKER}`,
      })
    );
  });

  test('a displaced note leaves the band; the count line keeps the session totals (§9.4)', async ($, on: Stubs) => {
    const file = { text: JSON.stringify({ maxNotesPerReview: 1 }), mtimeMs: 1 };
    stubBand(on, { files: { [`${HOME}/.claude/WATCHDOG.json`]: file } });
    await startReview($);
    await sendNote($, 'nit', NIT);
    await sendNote($, 'concern', NEW_CONCERN);
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-count': 'watchdog · 1 concern · 1 nit',
        'watchdog-card-0': ` CONCERN  default · just now · nudged${NEW_CONCERN}`,
      })
    );
  });
});

describe('band fit to maxRows (§13.1)', () => {
  const WHOLE = {
    'watchdog-count': 'watchdog · 1 blocker · 2 concerns · 1 nit',
    'watchdog-card-0': ` BLOCKER  default · just now · nudged${LISTED_BLOCKER}`,
    'watchdog-card-1': ` CONCERN  default · just now · nudged${LISTED_NEW}`,
    'watchdog-card-2': ` CONCERN  default · just now · nudged${LISTED_OLD}`,
    'watchdog-more': '  +1 more: 1 nit',
  };

  // A cut card shows one line of the flat text: no code ticks, a list item after a `; `.
  const CUT_NEW =
    ' CONCERN  default · just now · nudgedThe new /export route is open; it skips requireAuth; every other admin route has it';
  const CUT_OLD =
    ' CONCERN  default · just now · nudgedparseDate drops the timezone; date.spec.ts:40 passes only in UTC; CI runs in UTC';

  test('a band of at most maxRows rows shows every card whole, a blank row between', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await listedNotes($);
    expect(await rows($, { maxRows: 17 })).toEqual(onBoth(WHOLE));
    expect(await gaps($, { maxRows: 17 })).toEqual(onBoth(SPACED));
  });

  test('a taller band cuts the cards below the top one to one line, the last card first', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await listedNotes($);
    expect(await rows($, { maxRows: 16 })).toEqual(onBoth({ ...WHOLE, 'watchdog-card-2': CUT_OLD }));
    expect(await textProps($, [/^parseDate drops the timezone; /u], { maxRows: 16 })).toEqual(
      onBoth([{ wrap: 'truncate-end' }])
    );
    expect(await rows($, { maxRows: 14 })).toEqual(
      onBoth({ ...WHOLE, 'watchdog-card-1': CUT_NEW, 'watchdog-card-2': CUT_OLD })
    );
    expect(await gaps($, { maxRows: 14 })).toEqual(onBoth(SPACED));
  });

  test('the top card is never cut: the blank rows go, and a band still too tall scrolls', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await listedNotes($);
    expect(await rows($, { maxRows: 3 })).toEqual(
      onBoth({ ...WHOLE, 'watchdog-card-1': CUT_NEW, 'watchdog-card-2': CUT_OLD })
    );
    expect(await gaps($, { maxRows: 3 })).toEqual(onBoth(TIGHT));
  });

  test('a surface that gives no maxRows shows every card whole, a blank row between', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await listedNotes($);
    expect(await rows($, { maxRows: undefined })).toEqual(onBoth(WHOLE));
    expect(await gaps($, { maxRows: undefined })).toEqual(onBoth(SPACED));
  });
});

describe('narrow band (§13.1)', () => {
  test('below 80 bodyColumns, one line for each note: [<severity>] <text>, no blank row', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    expect(await rows($, { bodyColumns: 75 })).toEqual(
      onBoth({
        'watchdog-count': 'watchdog · 1 blocker · 2 concerns · 1 nit',
        'watchdog-card-0': `[blocker] ${BLOCKER}`,
        'watchdog-card-1': `[concern] ${NEW_CONCERN}`,
        'watchdog-card-2': `[concern] ${OLD_CONCERN}`,
        'watchdog-more': '  +1 more: 1 nit',
      })
    );
    expect(await gaps($, { bodyColumns: 75 })).toEqual(onBoth(TIGHT));
  });

  test('below 50 bodyColumns, the text is cut to min(40, bodyColumns - tag - 1) characters', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    // bodyColumns 45: `[blocker]` is 9 cells, so 35 characters, the last one `…`.
    expect(await rows($, { bodyColumns: 45 })).toEqual(
      onBoth({
        'watchdog-count': 'watchdog · 4 notes',
        'watchdog-card-0': '[blocker] The migration deletes the users ta…',
        'watchdog-card-1': '[concern] The new /export route skips requir…',
        'watchdog-card-2': '[concern] parseDate drops the timezone; the …',
        'watchdog-more': '  +1 more: 1 nit',
      })
    );
  });

  test('with a survey in the band, the watchdog draws nothing extra', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    expect(await rows($, { hasSurvey: true })).toEqual(onBoth({}));
    expect(await textProps($, [/./u], { hasSurvey: true })).toEqual(onBoth([{}]));
  });
});

describe('band clear and off (§13.1, §5.2)', () => {
  test('a person prompt clears the cards; the count line keeps the session totals', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    await $.prompt.submit(PERSON_PROMPT);
    await sendNote($, 'nit', 'The README still names the old CLI flag --legacy.');
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-count': 'watchdog · 1 blocker · 2 concerns · 2 nits',
        'watchdog-card-0':
          ' NIT  default · just now · aside on next promptThe README still names the old CLI flag --legacy.',
      })
    );
  });

  test('a task notification is not a person prompt: the cards stay (§10.5)', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await sendNote($, 'blocker', BLOCKER);
    await $.prompt.submit(TASK_NOTIFICATION);
    expect((await rows($)).map((shown) => shown['watchdog-card-0'])).toEqual(
      onBoth(` BLOCKER  default · just now · nudged${BLOCKER}`)
    );
  });

  test('/watchdog off makes the band one dim line', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    await $.command.run(typed('off'));
    expect(await rows($)).toEqual(onBoth({ 'watchdog-off': 'watchdog · off · /watchdog on' }));
    expect(await textProps($, [/^watchdog · off · \/watchdog on$/u])).toEqual(onBoth([{ dimColor: true }]));
  });

  test('a session that was never on draws nothing', async ($, on: Stubs) => {
    stubBand(on);
    await $.session.start(START);
    expect(await rows($)).toEqual(onBoth({}));
  });

  test('a headless session draws no card (§10.6)', async ($, on: Stubs) => {
    stubBand(on, { env: { HOME, CLAUDE_WATCHDOG: 'on' } });
    await $.session.start(HEADLESS_START);
    await $.agent.spawn(REVIEW_SPAWN);
    await sendNote($, 'blocker', BLOCKER);
    expect((await $.command.run(typed('status'))).text).toContain('watchdog on');
    expect(await rows($)).toEqual(onBoth({}));
  });
});

describe('band after a reload (§14.6, §11.3)', () => {
  // The `band` key as an earlier module instance wrote it: one blocker on an Explore subagent, one turn old.
  const STORED = {
    cards: [
      {
        key: `default\nasub0001\n${BLOCKER.toLowerCase()}`,
        seq: 1,
        name: 'default',
        severity: 'blocker',
        text: BLOCKER,
        turn: 1,
        delivery: 'steered',
        subagent: 'Explore',
      },
    ],
    totals: { blocker: 1, concern: 0, nit: 0 },
    turn: 2,
    seq: 1,
  };

  test('the cards come back from $.state; a note on a subagent shows its type', async ($, on: Stubs) => {
    stubBand(on, {}, { state: { isOn: true, source: '/watchdog on' }, band: STORED });
    await $.session.start(START);
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-count': 'watchdog · 1 blocker',
        'watchdog-card-0': ` BLOCKER  default · Explore · 1 turn ago · steered${BLOCKER}`,
      })
    );
    expect((await rows($, { bodyColumns: 75 })).map((shown) => shown['watchdog-card-0'])).toEqual(
      onBoth(`[blocker · Explore] ${BLOCKER}`)
    );
  });
});

describe('failure line (§12.5)', () => {
  const HALTED = {
    watchdogs: {
      default: {
        problem: { state: 'halted', reason: 'Overloaded', tries: 0, nextTryAt: NOW + 12 * 60_000 },
        failures: 3,
        refused: 0,
      },
    },
    lastError: 'default: Overloaded',
  };

  test('a halted watchdog shows one red line, short below 80 bodyColumns, and no card', async ($, on: Stubs) => {
    stubBand(on, {}, { state: { isOn: true, source: '/watchdog on' }, health: HALTED });
    await $.session.start(START);
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-count': 'watchdog · no notes',
        'watchdog-trouble': 'watchdog halted · retry in 12 min · /watchdog on to retry now',
      })
    );
    expect(await textProps($, [/^watchdog halted/u])).toEqual(onBoth([{ color: 'error', wrap: 'truncate-end' }]));
    expect((await rows($, { bodyColumns: 75 })).map((shown) => shown['watchdog-trouble'])).toEqual(
      onBoth('watchdog: 1 problem · /watchdog status')
    );
  });
});
