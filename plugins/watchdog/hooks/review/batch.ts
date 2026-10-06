import { BATCH_CAP } from '../constants';
import { elisionMarker } from '../feed/text';
import type { FeedRow, Update } from '../feed/feed';

// §7.5: omp's work-in-progress marker (`advisor/runtime.ts:933`), at the end of a batch whose last update
// closed mid-turn; and the marker of an update that an Esc closed.
const IN_PROGRESS = '\n\n---\n\n[in progress — more steps follow]';
const INTERRUPTED = '[turn interrupted by user]';

type Joined = { readonly blocks: readonly string[]; readonly label: string | undefined };

// omp `formatSessionHistoryMarkdown` with watched roles: a run of rows of one role shows under one label,
// and a row with no role ends the run. `form` picks the row's text; a row with none is left out.
const joinRows = (rows: readonly FeedRow[], form: (row: FeedRow) => string | undefined): string =>
  rows
    .reduce<Joined>(
      (joined, row) => {
        const text = form(row);
        const label = row.role === undefined ? undefined : `**${row.role}**:`;
        if (text === undefined) {
          return joined;
        }
        const block = label === undefined || label === joined.label ? text : `${label}\n${text}`;
        return { blocks: [...joined.blocks, block], label };
      },
      { blocks: [], label: undefined }
    )
    .blocks.join('\n\n');

// §7.6: a collapsed update keeps one line for each tool call and the person's text; the marker counts the rest.
const collapsed = (update: Update, full: string): string => {
  const brief = joinRows(update.rows, (row) => row.brief);
  const marker = full.length > brief.length ? elisionMarker(full.length - brief.length) : '';
  return [brief, marker].filter((part) => part !== '').join('\n');
};

type Collapse = { readonly texts: readonly string[]; readonly total: number };

// §7.6: over 120,000 chars, the oldest updates collapse first, until the batch fits or only the newest is
// full. §12.3: a compact batch collapses every update.
const fitBatch = (updates: readonly Update[], isCompact: boolean): readonly string[] => {
  const full = updates.map((update) => joinRows(update.rows, (row) => row.text));
  const start: Collapse = { texts: [], total: full.reduce((sum, text) => sum + text.length, 0) };
  return updates.reduce<Collapse>((fit, update, index) => {
    const text = full[index] ?? '';
    if (!isCompact && (fit.total <= BATCH_CAP || index === updates.length - 1)) {
      return { ...fit, texts: [...fit.texts, text] };
    }
    const brief = collapsed(update, text);
    return { texts: [...fit.texts, brief], total: fit.total - text.length + brief.length };
  }, start).texts;
};

// §7.5, §7.6: all updates that wait, merged in order into one review (omp joins them with a blank line), with
// the Esc marker after an interrupted update and the in-progress marker at the end.
export const renderBatch = (updates: readonly Update[], options: { readonly isCompact?: boolean } = {}): string => {
  const texts = fitBatch(updates, options.isCompact === true).map((text, index) =>
    updates[index]?.close === 'interrupted' ? `${text}\n\n${INTERRUPTED}` : text
  );
  const body = texts.join('\n\n');
  return updates.at(-1)?.close === 'step' ? `${body}${IN_PROGRESS}` : body;
};
