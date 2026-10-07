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
import { stateIn, stubState } from './fixtures/on-state';
import { HEADLESS_START, HOME, NOW, SESSION_ID, START, typed } from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { BandProps, BandSurface } from './fixtures/band';
import type { DeliveryEvents } from './fixtures/delivery';
import type { OnStateSeen, StateSeed } from './fixtures/on-state';
import type { Engine, Mounted } from 'claude-code/testing';

type Stubs = OnEvents<DeliveryEvents | 'state.get' | 'state.set' | 'ui.render'>;

const OLD_CONCERN = 'parseDate drops the timezone; the test at date.spec.ts:40 only passes in UTC.';
const NIT = '.env.example still lists STRIPE_SECRET; config.ts reads STRIPE_SECRET_KEY.';
const BLOCKER = 'The migration deletes the users table before it copies the rows.';
const NEW_CONCERN = 'The new /export route skips requireAuth; every other admin route has it.';

// §13.1: notes of a line and a list of 2 items; a collapsed card shows the first line.
const LISTED_BLOCKER =
  'The migration loses the users\n- `up()` drops `users` at line 12\n- the copy reads `users` at line 30';
const LISTED_NEW = 'The new /export route is open\n- it skips `requireAuth`\n- every other admin route has it';
const LISTED_OLD = 'parseDate drops the timezone\n- `date.spec.ts:40` passes only in UTC\n- CI runs in UTC';

// The keyed rows of the card list, top to bottom.
const LIST_KEYS = ['watchdog-card-0', 'watchdog-card-1', 'watchdog-card-2', 'watchdog-more'];

// The keyed rows of the watchdog's band, top to bottom.
const ROW_KEYS = ['watchdog-band', 'watchdog-off', 'watchdog-count', 'watchdog-trouble', ...LIST_KEYS];

// `bodyColumns` of the fixture band (§13.1 width facts: a terminal of 120 columns).
const WIDE = 115;

// §13.1: the count line and the off line: a rule of `bodyColumns` cells, the title after the first 2.
const ruled = (title: string, columns = WIDE): string => `── ${title} ${'─'.repeat(columns - title.length - 4)}`;

// §13.1: the count line over full cards: the rule ends with the focus hint, a space and 2 rule cells.
const hinted = (title: string, hotkeys: string, columns = WIDE): string => {
  const hint = `ctrl+x tab · ${hotkeys}`;
  return `── ${title} ${'─'.repeat(columns - title.length - hint.length - 8)} ${hint} ──`;
};

const stubBand = (on: Stubs, options: Parameters<typeof stubDelivery>[1] = {}, seed: StateSeed = {}): OnStateSeen => {
  stubDelivery(on, options);
  const state = stubState(on, seed);
  stubEngineBand(on);
  return state;
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

// The props of every element of one type, top to bottom.
const propsOf = async ($: Engine, type: string, props: BandProps = {}) =>
  onBand($, props, async (ui) => (await ui.findAll({ type })).map((found) => found.props));

// A person's press on the Button keyed `key`, on the terminal only: a press on each surface would toggle it twice.
const press = async ($: Engine, key: string): Promise<void> => {
  const ui = await $.ui.mount(bandTarget('terminal'));
  await ui.press({ key });
  await ui.unmount();
};

const onBoth = <T>(value: T): T[] => BAND_SURFACES.map(() => value);

describe('band cards (§13.1)', () => {
  test('the count line, then the 3 first notes by severity and newest, one row each with the first sentence, then +N more', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    expect(await textProps($, [new RegExp(`^${ENGINE_BAND}$`, 'u')])).toEqual(onBoth([{}]));
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-count': hinted('watchdog · 1 blocker · 2 concerns · 1 nit', 'a/b/c'),
        'watchdog-card-0': `▸ BLOCKER  default · ${BLOCKER} · just now · nudge pending`,
        'watchdog-card-1': `▸ CONCERN  default · ${NEW_CONCERN} · just now · nudge pending`,
        'watchdog-card-2': `▸ CONCERN  default · ${OLD_CONCERN} · just now · nudge pending`,
        'watchdog-more': '  +1 more: 1 nit',
      })
    );
    // One blank row above the band, none between its rows, and no body under a collapsed card.
    const margins = (await propsOf($, 'Box')).map((boxes) => boxes.filter((box) => 'marginTop' in box));
    expect(margins).toEqual(onBoth([{ marginTop: 1, flexDirection: 'column' }]));
    expect(await propsOf($, 'Markdown')).toEqual(onBoth([]));
  });

  test('a card row is one line cut at the end: the first line of a listed note, then the age and the delivery state', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await listedNotes($);
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-count': hinted('watchdog · 1 blocker · 2 concerns · 1 nit', 'a/b/c'),
        'watchdog-card-0': '▸ BLOCKER  default · The migration loses the users · just now · nudge pending',
        'watchdog-card-1': '▸ CONCERN  default · The new /export route is open · just now · nudge pending',
        'watchdog-card-2': '▸ CONCERN  default · parseDate drops the timezone · just now · nudge pending',
        'watchdog-more': '  +1 more: 1 nit',
      })
    );
    expect(await textProps($, [/^ BLOCKER {2}default · The migration loses the users · /u])).toEqual(
      onBoth([{ wrap: 'truncate-end' }])
    );
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
      onBoth(`▸ CONCERN  default · ${NEW_CONCERN} · 1 turn ago · steered`)
    );
  });

  test('a raise moves the card and the count to the higher severity (§9.1)', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await sendNote($, 'concern', BLOCKER);
    await sendNote($, 'blocker', BLOCKER);
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-count': hinted('watchdog · 1 blocker', 'a'),
        'watchdog-card-0': `▸ BLOCKER  default · ${BLOCKER} · just now · nudge pending`,
      })
    );
  });

  test('a displaced note leaves the band and the count line (§9.4)', async ($, on: Stubs) => {
    const file = { text: JSON.stringify({ maxNotesPerReview: 1 }), mtimeMs: 1 };
    stubBand(on, { files: { [`${HOME}/.claude/WATCHDOG.json`]: file } });
    await startReview($);
    await sendNote($, 'nit', NIT);
    expect((await rows($)).map((shown) => shown['watchdog-count'])).toEqual(onBoth(hinted('watchdog · 1 nit', 'a')));
    await sendNote($, 'concern', NEW_CONCERN);
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-count': hinted('watchdog · 1 concern', 'a'),
        'watchdog-card-0': `▸ CONCERN  default · ${NEW_CONCERN} · just now · nudge pending`,
      })
    );
  });
});

describe('band rule (§13.1)', () => {
  test('the count line is a dim rule that fills bodyColumns in each mode; the counts keep their colors', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    const counts = async (bodyColumns: number) =>
      (await rows($, { bodyColumns })).map((shown) => shown['watchdog-count']);
    expect(await counts(80)).toEqual(onBoth(hinted('watchdog · 1 blocker · 2 concerns · 1 nit', 'a/b/c', 80)));
    expect(await counts(75)).toEqual(onBoth(ruled('watchdog · 1 blocker · 2 concerns · 1 nit', 75)));
    expect(await counts(50)).toEqual(onBoth(ruled('watchdog · 1 blocker · 2 concerns · 1 nit', 50)));
    expect(await counts(45)).toEqual(onBoth(ruled('watchdog · 4 notes', 45)));
    expect((await counts(45)).map((count) => count?.length)).toEqual(onBoth(45));
    expect(await textProps($, [/^── $/u, /^ ─+ ctrl\+x tab · a\/b\/c ──$/u, /^watchdog · $/u])).toEqual(
      onBoth([{ dimColor: true }, { dimColor: true }, { dimColor: true }])
    );
    expect(await textProps($, [/^ ─+$/u], { bodyColumns: 75 })).toEqual(onBoth([{ dimColor: true }]));
  });

  test('over full cards the rule ends with the focus hint; the hint goes before the title is cut', async ($, on: Stubs) => {
    // 12,000 open cards: 1000 blockers, 1000 concerns, 10,000 nits.
    const severities = [
      ...Array.from({ length: 1000 }, () => 'blocker'),
      ...Array.from({ length: 1000 }, () => 'concern'),
      ...Array.from({ length: 10_000 }, () => 'nit'),
    ];
    const cards = severities.map((severity, index) => ({
      key: `k${index}`,
      seq: index + 1,
      name: 'default',
      severity,
      text: BLOCKER,
      turn: 1,
      delivery: 'nudged',
    }));
    const band = { cards, turn: 1, seq: cards.length, expanded: null };
    stubBand(on, {}, { state: { isOn: true, source: '/watchdog on' }, band });
    await $.session.start(START);
    const title = 'watchdog · 1000 blockers · 1000 concerns · 10000 nits';
    const counts = async (bodyColumns: number) =>
      (await rows($, { bodyColumns })).map((shown) => shown['watchdog-count']);
    // The title is 53 cells and the hint `ctrl+x tab · a/b/c` 18: with 2 rule cells and a space on each side of
    // both, the hint needs 81 columns.
    expect(await counts(81)).toEqual(onBoth(hinted(title, 'a/b/c', 81)));
    expect(await counts(80)).toEqual(onBoth(ruled(title, 80)));
  });

  test('with no room for 2 rule cells after the title, the title shows alone', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    // `watchdog · 4 notes` is 18 cells: 24 columns hold it with 2 rule cells and a space on each side.
    expect((await rows($, { bodyColumns: 24 })).map((shown) => shown['watchdog-count'])).toEqual(
      onBoth('── watchdog · 4 notes ──')
    );
    expect((await rows($, { bodyColumns: 23 })).map((shown) => shown['watchdog-count'])).toEqual(
      onBoth('watchdog · 4 notes')
    );
  });
});

describe('expand a card (§13.1)', () => {
  // The rows of `listedNotes` with each card collapsed.
  const COLLAPSED = {
    'watchdog-count': hinted('watchdog · 1 blocker · 2 concerns · 1 nit', 'a/b/c'),
    'watchdog-card-0': '▸ BLOCKER  default · The migration loses the users · just now · nudge pending',
    'watchdog-card-1': '▸ CONCERN  default · The new /export route is open · just now · nudge pending',
    'watchdog-card-2': '▸ CONCERN  default · parseDate drops the timezone · just now · nudge pending',
    'watchdog-more': '  +1 more: 1 nit',
  };

  test('each full card has a plain Button with a letter hotkey, never a digit; none below 80 bodyColumns', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await listedNotes($);
    const buttons = await propsOf($, 'Button');
    expect(buttons).toEqual(
      onBoth(
        ['a', 'b', 'c'].map((hotkey, index) => ({
          key: `watchdog-expand-${index}`,
          label: '▸',
          hotkey,
          plain: true,
          dimColor: true,
        }))
      )
    );
    expect(buttons.flat().filter((button) => /\d/u.test(String(button['hotkey'])))).toEqual([]);
    expect(await propsOf($, 'Button', { bodyColumns: 75 })).toEqual(onBoth([]));
  });

  test('a press expands the card: its header without the sentence, then its whole Markdown body, indented', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await listedNotes($);
    await press($, 'watchdog-expand-1');
    expect(await rows($)).toEqual(
      onBoth({ ...COLLAPSED, 'watchdog-card-1': `▾ CONCERN  default · just now · nudge pending${LISTED_NEW}` })
    );
    expect(await propsOf($, 'Markdown')).toEqual(onBoth([{ text: LISTED_NEW }]));
    expect(
      await onBand($, {}, async (ui) =>
        (await ui.findAll({ type: 'Box' })).filter((box) => box.props['marginLeft'] === 2).map((box) => box.text)
      )
    ).toEqual(onBoth([LISTED_NEW]));
  });

  test('a press on another card collapses the first; a press on the expanded card collapses it', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await listedNotes($);
    await press($, 'watchdog-expand-1');
    await press($, 'watchdog-expand-0');
    expect(await rows($)).toEqual(
      onBoth({ ...COLLAPSED, 'watchdog-card-0': `▾ BLOCKER  default · just now · nudge pending${LISTED_BLOCKER}` })
    );
    await press($, 'watchdog-expand-0');
    expect(await rows($)).toEqual(onBoth(COLLAPSED));
  });

  test('the band keeps the expanded card in $.state: a reload shows it expanded (§14.6)', async ($, on: Stubs) => {
    const key = `default\n\n${BLOCKER.toLowerCase()}`;
    const band = {
      cards: [{ key, seq: 1, name: 'default', severity: 'blocker', text: BLOCKER, turn: 1, delivery: 'nudged' }],
      totals: { blocker: 1, concern: 0, nit: 0 },
      turn: 1,
      seq: 1,
      expanded: key,
    };
    stubBand(on, {}, { state: { isOn: true, source: '/watchdog on' }, band });
    await $.session.start(START);
    expect((await rows($)).map((shown) => shown['watchdog-card-0'])).toEqual(
      onBoth(`▾ BLOCKER  default · just now · nudged${BLOCKER}`)
    );
    await press($, 'watchdog-expand-0');
    expect((await rows($)).map((shown) => shown['watchdog-card-0'])).toEqual(
      onBoth(`▸ BLOCKER  default · ${BLOCKER} · just now · nudged`)
    );
  });
});

describe('narrow band (§13.1)', () => {
  test('below 80 bodyColumns, one line for each note: [<severity>] <text>', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    expect(await rows($, { bodyColumns: 75 })).toEqual(
      onBoth({
        'watchdog-count': ruled('watchdog · 1 blocker · 2 concerns · 1 nit', 75),
        'watchdog-card-0': `[blocker] ${BLOCKER}`,
        'watchdog-card-1': `[concern] ${NEW_CONCERN}`,
        'watchdog-card-2': `[concern] ${OLD_CONCERN}`,
        'watchdog-more': '  +1 more: 1 nit',
      })
    );
  });

  test('below 50 bodyColumns, the text is cut to min(40, bodyColumns - tag - 1) characters', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    // bodyColumns 45: `[blocker]` is 9 cells, so 35 characters, the last one `…`.
    expect(await rows($, { bodyColumns: 45 })).toEqual(
      onBoth({
        'watchdog-count': ruled('watchdog · 4 notes', 45),
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
  test('a person prompt clears the cards and their count; a later card counts alone', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    await $.prompt.submit(PERSON_PROMPT);
    expect(await rows($)).toEqual(onBoth({ 'watchdog-count': ruled('watchdog · no open notes') }));
    expect((await rows($, { bodyColumns: 45 })).map((shown) => shown['watchdog-count'])).toEqual(
      onBoth(ruled('watchdog · no open notes', 45))
    );
    await sendNote($, 'nit', 'The README still names the old CLI flag --legacy.');
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-count': hinted('watchdog · 1 nit', 'a'),
        'watchdog-card-0':
          '▸ NIT  default · The README still names the old CLI flag --legacy. · just now · aside on next prompt',
      })
    );
  });

  test('a task notification is not a person prompt: the cards stay (§10.5)', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await sendNote($, 'blocker', BLOCKER);
    await $.prompt.submit(TASK_NOTIFICATION);
    expect((await rows($)).map((shown) => shown['watchdog-card-0'])).toEqual(
      onBoth(`▸ BLOCKER  default · ${BLOCKER} · just now · nudge pending`)
    );
  });

  test('/watchdog off makes the band one dim rule', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    await $.command.run(typed('off'));
    expect(await rows($)).toEqual(onBoth({ 'watchdog-off': ruled('watchdog · off · /watchdog on') }));
    expect(await rows($, { bodyColumns: 45 })).toEqual(
      onBoth({ 'watchdog-off': ruled('watchdog · off · /watchdog on', 45) })
    );
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
    turn: 2,
    seq: 1,
    expanded: null,
  };

  const ON = { isOn: true, source: '/watchdog on' };

  test('the cards come back from $.state; a note on a subagent shows its type', async ($, on: Stubs) => {
    stubBand(on, {}, { state: ON, band: STORED });
    await $.session.start(START);
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-count': hinted('watchdog · 1 blocker', 'a'),
        'watchdog-card-0': `▸ BLOCKER  default · Explore · ${BLOCKER} · 1 turn ago · steered`,
      })
    );
    expect((await rows($, { bodyColumns: 75 })).map((shown) => shown['watchdog-card-0'])).toEqual(
      onBoth(`[blocker · Explore] ${BLOCKER}`)
    );
  });

  test('a value of an earlier version with the session totals loads; the next write drops them', async ($, on: Stubs) => {
    const band = { ...STORED, totals: { blocker: 7, concern: 3, nit: 0 } };
    const state = stubBand(on, {}, { state: ON, band });
    await $.session.start(START);
    expect((await rows($)).map((shown) => shown['watchdog-count'])).toEqual(
      onBoth(hinted('watchdog · 1 blocker', 'a'))
    );
    await $.turn.start({ text: 'go on', turnId: 't2' });
    const written = stateIn(state, SESSION_ID, 'band');
    expect(written).toMatchObject({ cards: [{ key: STORED.cards[0]?.key }], seq: 1, expanded: null });
    expect(JSON.stringify(written)).not.toContain('totals');
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
        'watchdog-count': ruled('watchdog · no open notes'),
        'watchdog-trouble': 'watchdog halted · retry in 12 min · /watchdog on to retry now',
      })
    );
    expect(await textProps($, [/^watchdog halted/u])).toEqual(onBoth([{ color: 'error', wrap: 'truncate-end' }]));
    expect((await rows($, { bodyColumns: 75 })).map((shown) => shown['watchdog-trouble'])).toEqual(
      onBoth('watchdog: 1 problem · /watchdog status')
    );
  });
});
