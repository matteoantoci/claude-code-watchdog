import type { FeedRow } from '../feed/feed';

// §7.7: the spawn prompt. Here only part 4, the new updates; the recap parts and the caps (§7.6) join it.
export const reviewPrompt = (rows: readonly FeedRow[]): string =>
  ['New updates of the primary agent:', ...rows.map((row) => row.text)].join('\n\n');
