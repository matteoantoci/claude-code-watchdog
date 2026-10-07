import { TOKENS_K, TOKENS_M } from '../constants';
import { costText } from '../prices';
import type { Watchdog } from '../agents/roster';
import type { StatusSections } from '../command/status';
import type { Slot } from '../review/slots';
import type { Tally } from './ledger';

// A piece of text and whether the table draws it red (§12.4, §13.3).
export type Segment = { readonly text: string; readonly isRed: boolean };

// One row of the table: a watchdog or the session. `detail` is the reason of a problem state and the
// failure parts (§12.4), drawn under the row.
export type TableRow = {
  readonly name: string;
  readonly model: string;
  readonly state: Segment;
  readonly reviews: string;
  readonly notes: string;
  readonly tokens: string;
  readonly cost: string;
  readonly source: string;
  readonly detail: readonly Segment[];
};

// §13.3: the snapshot that the `CommandOutput` render draws for the reply `text` of one `/watchdog status`.
export type StatusTable = {
  readonly text: string;
  readonly head: string;
  readonly rows: readonly TableRow[];
  readonly session: TableRow | null;
  // §12.4: the last error, red; `last error: none` while on and there is none.
  readonly lastError: readonly Segment[];
  readonly lines: readonly string[];
};

// What the table reads of one watchdog when the command runs: its slot, its failure parts and its tally.
export type WatchdogStatus = {
  readonly watchdog: Watchdog;
  readonly slot: Slot;
  readonly parts: readonly string[];
  readonly tally: Tally;
};

// §12.4: whether each slot state shows red: the problem states do.
const RED_STATES: Readonly<Record<Slot['state'], boolean>> = {
  idle: false,
  disabled: false,
  reviewing: false,
  no_model: true,
  blocked: true,
  limited: true,
  halted: true,
};

// §6.3, §13.3: the tools a watchdog has without a mark; the roster never lists the mod's own tools.
const UNMARKED_TOOLS: Readonly<Record<string, true>> = { Read: true, Grep: true, Glob: true };

const TOOL_MARK = '*';

const TOOL_MARK_LINE = `${TOOL_MARK} has a tool other than Read, Grep and Glob`;

// `950`, `12.8k`, `1.3M`.
export const tokenText = (tokens: number): string => {
  if (tokens >= TOKENS_M) {
    return `${(tokens / TOKENS_M).toFixed(1)}M`;
  }
  return tokens >= TOKENS_K ? `${(tokens / TOKENS_K).toFixed(1)}k` : String(tokens);
};

const tallyCells = (tally: Tally): Pick<TableRow, 'reviews' | 'notes' | 'tokens' | 'cost'> => ({
  reviews: String(tally.reviews),
  notes: `${tally.notes.blocker}B ${tally.notes.concern}C ${tally.notes.nit}N`,
  tokens: tokenText(tally.tokens),
  cost: costText(tally.cost),
});

const hasMark = (watchdog: Watchdog): boolean => watchdog.tools.some((tool) => UNMARKED_TOOLS[tool] !== true);

// §12.4: the reason of a problem state, then the failure parts; `fail N/3` is red also on an idle watchdog.
const detailOf = (status: WatchdogStatus, isRed: boolean): Segment[] => [
  ...('reason' in status.slot ? [{ text: status.slot.reason, isRed: true }] : []),
  ...status.parts.map((part) => ({ text: part, isRed: isRed || part.startsWith('fail ') })),
];

// §13.3: the default watchdog row hints at the user file (§4.3); `configFile` is how the status names it.
const sourceOf = (watchdog: Watchdog, configFile: string | undefined): string =>
  watchdog.source ?? `write ${configFile ?? 'WATCHDOG.json'} to add watchdogs`;

// §13.3: the model column shows the model that ran (§12.2), before any review the roster's.
const watchdogRow = (status: WatchdogStatus, configFile: string | undefined): TableRow => {
  const { watchdog, slot, tally } = status;
  const isRed = RED_STATES[slot.state];
  return {
    name: hasMark(watchdog) ? `${watchdog.name}${TOOL_MARK}` : watchdog.name,
    model: `${tally.model ?? watchdog.model}/${watchdog.effort}`,
    state: { text: slot.state, isRed },
    ...tallyCells(tally),
    source: sourceOf(watchdog, configFile),
    detail: detailOf(status, isRed),
  };
};

// §13.3, §15: the first line with the session tokens and cost, one row for each watchdog, the session row,
// the last error, then the lines of the other areas. Off, the totals show once a review ran.
export const statusTable = (input: {
  readonly text: string;
  readonly sections: StatusSections;
  readonly watchdogs: readonly WatchdogStatus[];
  readonly session: Tally;
  readonly configFile: string | undefined;
}): StatusTable => {
  const { sections, session } = input;
  const rows = input.watchdogs.map((status) => watchdogRow(status, input.configFile));
  const hasTotals = rows.length > 0 || session.reviews > 0;
  const totals = hasTotals ? [`${tokenText(session.tokens)} tok`, costText(session.cost)] : [];
  const lastError =
    sections.errors.length === 0 && rows.length > 0
      ? [{ text: 'last error: none', isRed: false }]
      : sections.errors.map((text) => ({ text, isRed: true }));
  return {
    text: input.text,
    head: [...sections.head, ...totals].join(' · '),
    rows,
    session: hasTotals
      ? {
          name: 'session',
          model: '',
          state: { text: '', isRed: false },
          ...tallyCells(session),
          source: '',
          detail: [],
        }
      : null,
    lastError,
    lines: [...(input.watchdogs.some((status) => hasMark(status.watchdog)) ? [TOOL_MARK_LINE] : []), ...sections.lines],
  };
};
