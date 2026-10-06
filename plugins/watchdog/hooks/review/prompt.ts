import type { FeedRow } from '../feed/feed';

// §12.3 item 4: the retry at once of a prompt too large gets one line for each row; the person's own text
// stays whole (§7.6).
const compactRow = (row: FeedRow): string =>
  row.text.startsWith('user: ') && !row.text.startsWith('user: Tool result:')
    ? row.text
    : (row.text.split('\n')[0] ?? '');

// §7.7: the spawn prompt. Here only part 4, the new updates; the recap parts and the caps (§7.6) join it.
export const reviewPrompt = (rows: readonly FeedRow[], options: { isCompact?: boolean } = {}): string =>
  [
    'New updates of the primary agent:',
    ...rows.map((row) => (options.isCompact === true ? compactRow(row) : row.text)),
  ].join('\n\n');
