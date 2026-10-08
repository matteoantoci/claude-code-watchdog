import { describe, expect, test } from 'claude-code/testing';
import { hintGap } from '../hooks/band/tree';
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
import type { Band, Card } from '../hooks/band/cards';
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
const ROW_KEYS = [
  'watchdog-band',
  'watchdog-divider',
  'watchdog-off',
  'watchdog-count',
  'watchdog-trouble',
  ...LIST_KEYS,
];

// `bodyColumns` of the fixture band (§13.1 width facts: a terminal of 120 columns).
const WIDE = 115;

// §13.1: the band's first row: a dotted line of `bodyColumns` cells.
const divider = (columns = WIDE): string => '┄'.repeat(columns);

// §13.1: the count line over full cards: the title, then the focus hint flush right at `bodyColumns`.
const hinted = (title: string, hotkeys: string, columns = WIDE): string => {
  const hint = `ctrl+x tab · ${hotkeys} · esc`;
  return `${title}${' '.repeat(columns - title.length - hint.length)}${hint}`;
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

// An element of `ui.drawn()`, plain data: the props that add blank rows, its `key`, and its children.
type Placed = {
  type: string;
  props?: Partial<Record<`${'margin' | 'padding'}${'' | 'Y' | 'Top' | 'Bottom'}`, number>> & { key?: string };
  children?: readonly unknown[];
};

const isPlaced = (node: unknown): node is Placed => typeof node === 'object' && node !== null && 'type' in node;

// A row of the watchdog's band, keyed as `ROW_KEYS` keys it (an expanded card with its body).
const ROW_KEY = /^watchdog-(?:divider|off|count|trouble|card-\d|more)$/u;

// The blank rows that a Box's margin and padding add on one side.
const blanks = (side: 'Top' | 'Bottom', props: NonNullable<Placed['props']> = {}): string[] => {
  const margin = props[`margin${side}`] ?? props.marginY ?? props.margin ?? 0;
  const padding = props[`padding${side}`] ?? props.paddingY ?? props.padding ?? 0;
  return Array.from({ length: margin + padding }, () => 'blank');
};

// §13.1: the rows of a drawn element top to bottom, as the column Boxes stack them: a watchdog row by its key,
// another leaf (the kit's engine band) by its text, and `blank` for each row that a margin or a padding adds.
const stack = (node: Placed): string[] => {
  const key = node.props?.key;
  const children = node.children ?? [];
  const inner = key !== undefined && ROW_KEY.test(key) ? [key] : children.filter(isPlaced).flatMap(stack);
  const shown =
    inner.length === 0 ? [children.filter((child): child is string => typeof child === 'string').join('')] : inner;
  return [...blanks('Top', node.props), ...shown, ...blanks('Bottom', node.props)];
};

// The rows of the band as drawn, the engine's band first.
const layout = async ($: Engine, props: BandProps = {}): Promise<string[][]> =>
  onBand($, props, async (ui) => {
    const drawn: unknown = await ui.drawn();
    return isPlaced(drawn) ? stack(drawn) : [];
  });

// A person's press on the Button keyed `key`, on the terminal only: a press on each surface would toggle it twice.
const press = async ($: Engine, key: string): Promise<void> => {
  const ui = await $.ui.mount(bandTarget('terminal'));
  await ui.press({ key });
  await ui.unmount();
};

const onBoth = <T>(value: T): T[] => BAND_SURFACES.map(() => value);

describe('band cards (§13.1)', () => {
  test('the count line, then the 3 first notes by severity and newest, one row each with the first sentence and the status, then +N more', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    expect(await textProps($, [new RegExp(`^${ENGINE_BAND}$`, 'u')])).toEqual(onBoth([{}]));
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-divider': divider(),
        'watchdog-count': hinted('watchdog · 1 blocker · 2 concerns · 1 nit', 'a/b/c'),
        'watchdog-card-0': `▸ BLOCKER  ${BLOCKER}  nudge pending`,
        'watchdog-card-1': `▸ CONCERN  ${NEW_CONCERN}  nudge pending`,
        'watchdog-card-2': `▸ CONCERN  ${OLD_CONCERN}  nudge pending`,
        'watchdog-more': '  +1 more: 1 nit',
      })
    );
    // No body under a collapsed card.
    expect(await propsOf($, 'Markdown')).toEqual(onBoth([]));
  });

  test('a card row is one line: the first line of a listed note, cut at the end, then the status', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await listedNotes($);
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-divider': divider(),
        'watchdog-count': hinted('watchdog · 1 blocker · 2 concerns · 1 nit', 'a/b/c'),
        'watchdog-card-0': '▸ BLOCKER  The migration loses the users  nudge pending',
        'watchdog-card-1': '▸ CONCERN  The new /export route is open  nudge pending',
        'watchdog-card-2': '▸ CONCERN  parseDate drops the timezone  nudge pending',
        'watchdog-more': '  +1 more: 1 nit',
      })
    );
    expect(await textProps($, [/^ BLOCKER {2}The migration loses the users$/u, /^ {2}nudge pending$/u])).toEqual(
      onBoth([{ wrap: 'truncate-end' }, { dimColor: true }])
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

  test('a steered note shows no status; its expanded header shows its age in turns and its delivery state', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await sendNote($, 'concern', NEW_CONCERN);
    await $.prompt.submit(TASK_NOTIFICATION);
    await $.turn.start({ text: TASK_NOTIFICATION.text, turnId: 't1' });
    expect((await rows($)).map((shown) => shown['watchdog-card-0'])).toEqual(onBoth(`▸ CONCERN  ${NEW_CONCERN}`));
    await press($, 'watchdog-expand-0');
    expect((await rows($)).map((shown) => shown['watchdog-card-0'])).toEqual(
      onBoth(`▾ CONCERN  default · 1 turn ago · steered${NEW_CONCERN}`)
    );
  });

  test('a raise moves the card and the count to the higher severity (§9.1)', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await sendNote($, 'concern', BLOCKER);
    await sendNote($, 'blocker', BLOCKER);
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-divider': divider(),
        'watchdog-count': hinted('watchdog · 1 blocker', 'a'),
        'watchdog-card-0': `▸ BLOCKER  ${BLOCKER}  nudge pending`,
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
        'watchdog-divider': divider(),
        'watchdog-count': hinted('watchdog · 1 concern', 'a'),
        'watchdog-card-0': `▸ CONCERN  ${NEW_CONCERN}  nudge pending`,
      })
    );
  });
});

// Live check on 2.1.292 (fullscreen): the engine draws its `[-]` on the band's first row, whatever that row holds,
// and keeps one blank row of its own between the band and the prompt, with no band too.
describe('band rows (§13.1)', () => {
  test('the divider, then the count line; one blank row parts them from the cards and +N more in each mode; none after them', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    const order = [ENGINE_BAND, 'watchdog-divider', 'watchdog-count', 'blank', ...LIST_KEYS];
    expect(await layout($)).toEqual(onBoth(order));
    expect(await layout($, { bodyColumns: 75 })).toEqual(onBoth(order));
    expect(await layout($, { bodyColumns: 45 })).toEqual(onBoth(order));
  });

  test('an expanded card keeps the rows: its body is inside its own row', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await listedNotes($);
    await press($, 'watchdog-expand-0');
    expect(await layout($)).toEqual(onBoth([ENGINE_BAND, 'watchdog-divider', 'watchdog-count', 'blank', ...LIST_KEYS]));
  });

  test('with no card and no failure line, the divider and the count line: no blank row under them', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    await $.prompt.submit(PERSON_PROMPT);
    expect(await layout($)).toEqual(onBoth([ENGINE_BAND, 'watchdog-divider', 'watchdog-count']));
  });

  test('after /watchdog off, the divider and the off line', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    await $.command.run(typed('off'));
    expect(await layout($)).toEqual(onBoth([ENGINE_BAND, 'watchdog-divider', 'watchdog-off']));
  });
});

describe('band divider and count line (§13.1)', () => {
  test('the divider is a subtle dotted line across bodyColumns in each mode; the count line is its title, the counts in their colors', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    const shown = async (bodyColumns: number) =>
      (await rows($, { bodyColumns })).map((row) => [row['watchdog-divider'], row['watchdog-count']]);
    expect(await shown(80)).toEqual(
      onBoth([divider(80), hinted('watchdog · 1 blocker · 2 concerns · 1 nit', 'a/b/c', 80)])
    );
    expect(await shown(75)).toEqual(onBoth([divider(75), 'watchdog · 1 blocker · 2 concerns · 1 nit']));
    expect(await shown(50)).toEqual(onBoth([divider(50), 'watchdog · 1 blocker · 2 concerns · 1 nit']));
    expect(await shown(45)).toEqual(onBoth([divider(45), 'watchdog · 4 notes']));
    expect(await textProps($, [/^┄+$/u, /^watchdog · $/u, /^ctrl\+x tab · a\/b\/c · esc$/u])).toEqual(
      onBoth([{ color: 'subtle' }, { dimColor: true }, { dimColor: true }])
    );
    expect(await textProps($, [/^watchdog · 1 blocker · 2 concerns · 1 nit +ctrl/u])).toEqual(
      onBoth([{ wrap: 'truncate-end' }])
    );
  });

  test('over full cards the focus hint ends at bodyColumns, with the largest counts too', async ($, on: Stubs) => {
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
    expect((await rows($, { bodyColumns: 80 })).map((shown) => shown['watchdog-count'])).toEqual(
      onBoth(hinted(title, 'a/b/c', 80))
    );
  });

  test('the hint needs 2 blank cells after the title; with less room it goes, before the title is cut', () => {
    // The title is 53 cells and the hint `ctrl+x tab · a/b/c · esc` 24.
    const title = 'watchdog · 1000 blockers · 1000 concerns · 10000 nits';
    expect(hintGap(79, title, 'ctrl+x tab · a/b/c · esc')).toBe(2);
    expect(hintGap(78, title, 'ctrl+x tab · a/b/c · esc')).toBeUndefined();
  });
});

describe('expand a card (§13.1)', () => {
  // The rows of `listedNotes` with each card collapsed.
  const COLLAPSED = {
    'watchdog-divider': divider(),
    'watchdog-count': hinted('watchdog · 1 blocker · 2 concerns · 1 nit', 'a/b/c'),
    'watchdog-card-0': '▸ BLOCKER  The migration loses the users  nudge pending',
    'watchdog-card-1': '▸ CONCERN  The new /export route is open  nudge pending',
    'watchdog-card-2': '▸ CONCERN  parseDate drops the timezone  nudge pending',
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

  test('a press expands the card: its header with every field, then its whole Markdown body, indented', async ($, on: Stubs) => {
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
    expect((await rows($)).map((shown) => shown['watchdog-card-0'])).toEqual(onBoth(`▸ BLOCKER  ${BLOCKER}`));
  });
});

describe('narrow band (§13.1)', () => {
  test('below 80 bodyColumns, one line for each note: [<severity>] <text>, then the status', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    expect(await rows($, { bodyColumns: 75 })).toEqual(
      onBoth({
        'watchdog-divider': divider(75),
        'watchdog-count': 'watchdog · 1 blocker · 2 concerns · 1 nit',
        'watchdog-card-0': `[blocker] ${BLOCKER}  nudge pending`,
        'watchdog-card-1': `[concern] ${NEW_CONCERN}  nudge pending`,
        'watchdog-card-2': `[concern] ${OLD_CONCERN}  nudge pending`,
        'watchdog-more': '  +1 more: 1 nit',
      })
    );
  });

  test('below 50 bodyColumns, the text is cut to min(40, bodyColumns - tag - 1) characters less the status', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    // bodyColumns 45: `[blocker]` is 9 cells, so 35 cells; `  nudge pending` takes 15, so 20 characters, the last
    // one `…`.
    expect(await rows($, { bodyColumns: 45 })).toEqual(
      onBoth({
        'watchdog-divider': divider(45),
        'watchdog-count': 'watchdog · 4 notes',
        'watchdog-card-0': '[blocker] The migration delet…  nudge pending',
        'watchdog-card-1': '[concern] The new /export rou…  nudge pending',
        'watchdog-card-2': '[concern] parseDate drops the…  nudge pending',
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

// A stored card (§14.6) of the default watchdog on the primary agent, 1 turn old in a band at turn 2.
const storedCard = (seq: number, delivery: string, fields: Partial<Card> = {}): Card => ({
  key: `k${seq}`,
  seq,
  name: 'default',
  severity: 'blocker',
  text: BLOCKER,
  turn: 1,
  delivery,
  watchdog: 'default',
  agentId: 'afake0001',
  batchEdits: 0,
  edits: 0,
  ...fields,
});

// The `band` key as an earlier module instance wrote it, at turn 2.
const storedBand = (cards: readonly Card[], expanded: string | null = null): Band => ({
  cards,
  turn: 2,
  seq: cards.length,
  expanded,
});

// The text of the card rows at `bodyColumns`, top to bottom.
const cardRows = async ($: Engine, bodyColumns = WIDE): Promise<(string | undefined)[][]> =>
  (await rows($, { bodyColumns })).map((shown) => LIST_KEYS.slice(0, -1).map((key) => shown[key]));

// §4.3: a user `WATCHDOG.json` with the default watchdog and a second one, enabled unless `enabled` says not.
const twoWatchdogs = (enabled = true): Parameters<typeof stubDelivery>[1] => ({
  files: {
    [`${HOME}/.claude/WATCHDOG.json`]: {
      text: JSON.stringify({ watchdogs: [{ name: 'default' }, { name: 'security', enabled }] }),
      mtimeMs: 1,
    },
  },
});

describe('card row status (§13.1, §11.3, §10.8)', () => {
  const ON = { isOn: true, source: '/watchdog on' };

  // A one-sentence note longer than any row.
  const LONG = `${'The migration deletes the users table before it copies the rows and '.repeat(6)}then it ends.`;

  test('a note the agent has shows no status; a note that waits shows its state', async ($, on: Stubs) => {
    const band = storedBand([
      storedCard(1, 'steered'),
      storedCard(2, 'nudged', { text: NEW_CONCERN }),
      storedCard(3, 'held', { text: NIT }),
    ]);
    stubBand(on, {}, { state: ON, band });
    await $.session.start(START);
    expect(await cardRows($)).toEqual(
      onBoth([`▸ BLOCKER  ${NIT}  held`, `▸ BLOCKER  ${NEW_CONCERN}`, `▸ BLOCKER  ${BLOCKER}`])
    );
  });

  test('`nudge pending` as it is, `aside on next prompt` as `aside`, the outdated mark short after the state', async ($, on: Stubs) => {
    const band = storedBand([
      storedCard(1, 'nudge pending'),
      storedCard(2, 'aside on next prompt', { text: NEW_CONCERN }),
      storedCard(3, 'held', { text: NIT, edits: 2 }),
    ]);
    stubBand(on, {}, { state: ON, band });
    await $.session.start(START);
    expect(await cardRows($)).toEqual(
      onBoth([
        `▸ BLOCKER  ${NIT}  held · outdated? 2 edits`,
        `▸ BLOCKER  ${NEW_CONCERN}  aside`,
        `▸ BLOCKER  ${BLOCKER}  nudge pending`,
      ])
    );
  });

  test('a note on a subagent shows its type first; a one-line card has it in its tag, and the status only when it fits', async ($, on: Stubs) => {
    const band = storedBand([
      storedCard(1, 'nudge pending', { subagent: 'Explore', subagentId: 'asub0001', edits: 1 }),
    ]);
    stubBand(on, {}, { state: ON, band });
    await $.session.start(START);
    expect(await cardRows($)).toEqual(
      onBoth([`▸ BLOCKER  ${BLOCKER}  Explore · nudge pending · outdated? 1 edit`, undefined, undefined])
    );
    // bodyColumns 75: `[blocker · Explore]` and a blank leave 55 cells, the status and its gap 34, so 21 for the text.
    expect((await cardRows($, 75)).map(([first]) => first)).toEqual(
      onBoth(`[blocker · Explore] ${BLOCKER}  nudge pending · outdated? 1 edit`)
    );
    // bodyColumns 70: 16 cells, fewer than 20, so no status, and the row stays one row.
    expect((await cardRows($, 70)).map(([first]) => first)).toEqual(onBoth(`[blocker · Explore] ${BLOCKER}`));
  });

  test('a row names the watchdog only when 2 or more watchdogs are enabled', async ($, on: Stubs) => {
    stubBand(on, twoWatchdogs(), { state: ON, band: storedBand([storedCard(1, 'held')]) });
    await $.session.start(START);
    expect((await cardRows($)).map(([first]) => first)).toEqual(onBoth(`▸ BLOCKER  default · ${BLOCKER}  held`));
    expect(await textProps($, [/^default$/u, /^ · $/u])).toEqual(onBoth([{ bold: true }, { dimColor: true }]));
  });

  test('a second watchdog that is not enabled leaves one on: the row does not name it', async ($, on: Stubs) => {
    stubBand(on, twoWatchdogs(false), { state: ON, band: storedBand([storedCard(1, 'held')]) });
    await $.session.start(START);
    expect((await cardRows($)).map(([first]) => first)).toEqual(onBoth(`▸ BLOCKER  ${BLOCKER}  held`));
  });

  test('at 80 and 160 bodyColumns a long sentence is cut at the end; the status never shrinks and is never cut', async ($, on: Stubs) => {
    stubBand(on, {}, { state: ON, band: storedBand([storedCard(1, 'held', { text: LONG, edits: 1 })]) });
    await $.session.start(START);
    const status = '  held · outdated? 1 edit';
    const flexes = async (bodyColumns: number) =>
      onBand($, { bodyColumns }, async (ui) =>
        (await ui.findAll({ type: 'Box' }))
          .filter((box) => box.props['flexShrink'] !== undefined)
          .map((box) => ({ text: box.text, grow: box.props['flexGrow'], shrink: box.props['flexShrink'] }))
      );
    const expected = onBoth([
      { text: ` BLOCKER  ${LONG}${status}`, grow: 1, shrink: 1 },
      { text: ` BLOCKER  ${LONG}`, grow: 1, shrink: 1 },
      { text: status, grow: undefined, shrink: 0 },
    ]);
    expect(await flexes(80)).toEqual(expected);
    expect(await flexes(160)).toEqual(expected);
    const texts = [/^ BLOCKER {2}The migration .* then it ends\.$/u, /^ {2}held · outdated\? 1 edit$/u];
    expect(await textProps($, texts, { bodyColumns: 80 })).toEqual(
      onBoth([{ wrap: 'truncate-end' }, { dimColor: true }])
    );
  });

  // The longest status: a subagent's type, `nudge pending`, a 2-digit mark; the 3 watchdog names push the sentence
  // further right, from `a: ▸  BLOCKER  security · ` (26 cells) to 43 cells.
  const WORST = storedBand(
    ['database-migration-review', 'migrations-review', 'security'].map((name, index) =>
      storedCard(index + 1, 'nudge pending', {
        name,
        text: LONG,
        subagent: 'general-purpose',
        subagentId: 'asub0001',
        edits: 12,
      })
    )
  );
  const named = (name: string, status: string): string =>
    `▸ BLOCKER  ${name} · ${LONG}${status === '' ? '' : `  ${status}`}`;

  test('a full card row keeps 20 cells of sentence: the type goes, then `pending`, then `outdated?`, then the status', async ($, on: Stubs) => {
    stubBand(on, twoWatchdogs(), { state: ON, band: WORST });
    await $.session.start(START);
    // bodyColumns 80: 54, 45 and 37 cells after each name; `pending · outdated? 12 edits` and its gap leave 24 of 54,
    // `pending · outdated?` 24 of 45, and 16 of 37, so no status.
    expect(await cardRows($, 80)).toEqual(
      onBoth([
        named('security', 'pending · outdated? 12 edits'),
        named('migrations-review', 'pending · outdated?'),
        named('database-migration-review', ''),
      ])
    );
    // bodyColumns 85: 59, 50 and 42 cells; `nudge pending · outdated? 12 edits` leaves 23 of 59.
    expect(await cardRows($, 85)).toEqual(
      onBoth([
        named('security', 'nudge pending · outdated? 12 edits'),
        named('migrations-review', 'pending · outdated? 12 edits'),
        named('database-migration-review', 'pending · outdated?'),
      ])
    );
  });

  test('at 160 bodyColumns a full card row shows every status item', async ($, on: Stubs) => {
    stubBand(on, twoWatchdogs(), { state: ON, band: WORST });
    await $.session.start(START);
    const status = 'general-purpose · nudge pending · outdated? 12 edits';
    expect(await cardRows($, 160)).toEqual(
      onBoth(['security', 'migrations-review', 'database-migration-review'].map((name) => named(name, status)))
    );
  });

  test('an expanded card names every field: the watchdog, the subagent type, the age, the state, the whole mark', async ($, on: Stubs) => {
    const expanded = storedCard(1, 'nudge pending', { subagent: 'Explore', subagentId: 'asub0001', edits: 1 });
    stubBand(on, {}, { state: ON, band: storedBand([expanded], 'k1') });
    await $.session.start(START);
    expect((await cardRows($)).map(([first]) => first)).toEqual(
      onBoth(`▾ BLOCKER  default · Explore · 1 turn ago · nudge pending · may be outdated: 1 edit since${BLOCKER}`)
    );
  });

  test('below 50 bodyColumns the status takes its cells from the cut text, and goes when 20 would not stay', async ($, on: Stubs) => {
    const band = storedBand([storedCard(1, 'held'), storedCard(2, 'nudge pending', { text: NEW_CONCERN, edits: 2 })]);
    stubBand(on, {}, { state: ON, band });
    await $.session.start(START);
    // bodyColumns 45: 35 cells after `[blocker] `; `  held` leaves 29; `  nudge pending · outdated? 2 edits` 0.
    expect(await cardRows($, 45)).toEqual(
      onBoth([
        '[blocker] The new /export route skips requir…',
        '[blocker] The migration deletes the us…  held',
        undefined,
      ])
    );
  });
});

describe('band clear and off (§13.1, §5.2)', () => {
  test('a person prompt clears the cards and their count; a later card counts alone', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    await $.prompt.submit(PERSON_PROMPT);
    expect(await rows($)).toEqual(
      onBoth({ 'watchdog-divider': divider(), 'watchdog-count': 'watchdog · no open notes' })
    );
    expect(await rows($, { bodyColumns: 45 })).toEqual(
      onBoth({ 'watchdog-divider': divider(45), 'watchdog-count': 'watchdog · no open notes' })
    );
    await sendNote($, 'nit', 'The README still names the old CLI flag --legacy.');
    expect(await rows($)).toEqual(
      onBoth({
        'watchdog-divider': divider(),
        'watchdog-count': hinted('watchdog · 1 nit', 'a'),
        'watchdog-card-0': '▸ NIT  The README still names the old CLI flag --legacy.  aside',
      })
    );
  });

  test('a task notification is not a person prompt: the cards stay (§10.5)', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await sendNote($, 'blocker', BLOCKER);
    await $.prompt.submit(TASK_NOTIFICATION);
    expect((await rows($)).map((shown) => shown['watchdog-card-0'])).toEqual(
      onBoth(`▸ BLOCKER  ${BLOCKER}  nudge pending`)
    );
  });

  test('/watchdog off makes the band the divider and one dim line', async ($, on: Stubs) => {
    stubBand(on);
    await startReview($);
    await fourNotes($);
    await $.command.run(typed('off'));
    expect(await rows($)).toEqual(
      onBoth({ 'watchdog-divider': divider(), 'watchdog-off': 'watchdog · off · /watchdog on' })
    );
    expect(await rows($, { bodyColumns: 45 })).toEqual(
      onBoth({ 'watchdog-divider': divider(45), 'watchdog-off': 'watchdog · off · /watchdog on' })
    );
    expect(await textProps($, [/^watchdog · off · \/watchdog on$/u])).toEqual(
      onBoth([{ dimColor: true, wrap: 'truncate-end' }])
    );
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
        'watchdog-divider': divider(),
        'watchdog-count': hinted('watchdog · 1 blocker', 'a'),
        'watchdog-card-0': `▸ BLOCKER  ${BLOCKER}  Explore`,
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
        'watchdog-divider': divider(),
        'watchdog-count': 'watchdog · no open notes',
        'watchdog-trouble': 'watchdog halted · retry in 12 min · /watchdog on to retry now',
      })
    );
    // §13.1: the blank row parts the count line from the failure line too.
    expect(await layout($)).toEqual(
      onBoth([ENGINE_BAND, 'watchdog-divider', 'watchdog-count', 'blank', 'watchdog-trouble'])
    );
    expect(await textProps($, [/^watchdog halted/u])).toEqual(onBoth([{ color: 'error', wrap: 'truncate-end' }]));
    expect((await rows($, { bodyColumns: 75 })).map((shown) => shown['watchdog-trouble'])).toEqual(
      onBoth('watchdog: 1 problem · /watchdog status')
    );
  });
});
