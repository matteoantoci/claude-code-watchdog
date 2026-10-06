import {
  STATUS_COST_WIDTH,
  STATUS_DETAIL_INDENT,
  STATUS_MODEL_WIDTH,
  STATUS_NAME_WIDTH,
  STATUS_NARROW_COLUMNS,
  STATUS_NOTES_WIDTH,
  STATUS_REVIEWS_WIDTH,
  STATUS_STATE_WIDTH,
  STATUS_TOKENS_WIDTH,
} from '../constants';
import type { Segment, StatusTable, TableRow } from './table';
import type { BoxProps, ElementConstructor, RenderElement, RenderNode, TextProps } from 'claude-code';

// The elements the table draws with: every surface has them (§13.1 uses only `Box`, `Text` and `Markdown`).
export type TableElements = {
  readonly Box: ElementConstructor<BoxProps>;
  readonly Text: ElementConstructor<TextProps>;
};

type Column = Exclude<keyof TableRow, 'state' | 'detail'> | 'state';

// §13.3: the cells of each column; `source` takes the rest of the row.
const WIDTHS: Readonly<Record<Exclude<Column, 'source'>, number>> = {
  name: STATUS_NAME_WIDTH,
  model: STATUS_MODEL_WIDTH,
  state: STATUS_STATE_WIDTH,
  reviews: STATUS_REVIEWS_WIDTH,
  notes: STATUS_NOTES_WIDTH,
  tokens: STATUS_TOKENS_WIDTH,
  cost: STATUS_COST_WIDTH,
};

const HEADER: TableRow = {
  name: 'name',
  model: 'model',
  state: { text: 'state', isRed: false },
  reviews: 'reviews',
  notes: 'notes',
  tokens: 'tokens',
  cost: 'cost',
  source: 'file',
  detail: [],
};

const segmentText = (E: TableElements, segment: Segment): RenderNode =>
  segment.isRed ? E.Text({ color: 'error', children: segment.text }) : segment.text;

const cell = (E: TableElements, style: TextProps, [column, node]: readonly [Column, RenderNode]): RenderElement =>
  E.Box({
    ...(column === 'source' ? { flexGrow: 1 } : { width: WIDTHS[column], flexShrink: 0 }),
    children: [E.Text({ ...style, wrap: 'truncate-end', children: node })],
  });

const rowBox = (
  E: TableElements,
  row: TableRow,
  look: { readonly key: string; readonly style: TextProps }
): RenderElement =>
  E.Box({
    key: look.key,
    flexDirection: 'row',
    children: [
      ['name', row.name] as const,
      ['model', row.model] as const,
      ['state', segmentText(E, row.state)] as const,
      ...(['reviews', 'notes', 'tokens', 'cost', 'source'] as const).map((column) => [column, row[column]] as const),
    ].map((entry) => cell(E, look.style, entry)),
  });

// The reason and the failure parts of a watchdog, indented under its row.
const detailLine = (E: TableElements, row: TableRow): RenderElement[] =>
  row.detail.length === 0
    ? []
    : [
        E.Box({
          marginLeft: STATUS_DETAIL_INDENT,
          children: [
            E.Text({
              wrap: 'truncate-end',
              children: row.detail.flatMap((segment, index) => [index === 0 ? '' : ' · ', segmentText(E, segment)]),
            }),
          ],
        }),
      ];

// §13.3: below 80 columns a row is `name state $`.
const narrowRow = (E: TableElements, key: string, row: TableRow): RenderElement =>
  E.Box({
    key,
    children: [
      E.Text({
        wrap: 'truncate-end',
        children: [row.name, ...(row.state.text === '' ? [] : [' ', segmentText(E, row.state)]), ' ', row.cost],
      }),
    ],
  });

const rowsOf = (E: TableElements, table: StatusTable, isNarrow: boolean): RenderElement[] => {
  const session = table.session === null ? [] : [table.session];
  if (isNarrow) {
    return [
      ...table.rows.map((row) => narrowRow(E, `row:${row.name}`, row)),
      ...session.map((row) => narrowRow(E, 'session', row)),
    ];
  }
  return [
    ...(table.rows.length === 0
      ? []
      : [rowBox(E, HEADER, { key: 'header', style: { dimColor: true, underline: true } })]),
    ...table.rows.flatMap((row) => [rowBox(E, row, { key: `row:${row.name}`, style: {} }), ...detailLine(E, row)]),
    ...session.map((row) => rowBox(E, row, { key: 'session', style: { bold: true } })),
  ];
};

const lineText = (E: TableElements, text: string, style: TextProps): RenderElement =>
  E.Text({ ...style, wrap: 'truncate-end', children: text });

// §13.3: the snapshot of one `/watchdog status`: the first line, the rows, the session row, `last error` (red
// when there is one), then the lines of the other areas. `columns` is the width the surface measured.
export const drawStatus = (E: TableElements, table: StatusTable, columns: number | undefined): RenderElement =>
  E.Box({
    key: 'watchdog-status',
    flexDirection: 'column',
    children: [
      lineText(E, table.head, { bold: true }),
      ...rowsOf(E, table, columns !== undefined && columns < STATUS_NARROW_COLUMNS),
      ...table.lastError.map((line) => lineText(E, line.text, line.isRed ? { color: 'error' } : { dimColor: true })),
      ...table.lines.map((line) => lineText(E, line, {})),
    ],
  });
