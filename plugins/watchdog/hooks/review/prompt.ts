import { renderBatch } from './batch';
import { recapPrompts, recapUpdates } from './recap';
import type { Update } from '../feed/feed';
import type { RecapNote } from '../note/history';
import type { RecapSource } from './recap';

// §7.7: what one spawn prompt is built from: the new updates (part 4), the watchdog's newest 20 notes
// (part 1, oldest first as `notes:<sessionId>` keeps them), and the recap source of parts 2 and 3. §11.2:
// `subagent` is the type of a watched subagent; its part 2 is its task.
export type ReviewInput = RecapSource & {
  readonly updates: readonly Update[];
  readonly notes: readonly RecapNote[];
  readonly subagent?: string;
};

const part = (heading: string, body: string): string[] => (body === '' ? [] : [`### ${heading}\n\n${body}`]);

// §7.7: the spawn prompt has 4 parts, each newest first: the watchdog's notes with their severity and
// delivery state, the person's prompts, the older updates, and the new updates under omp's
// `### Session update` heading (`advisor/runtime.ts:930`). Part 4 keeps its updates in order, because §7.5
// ends it with the in-progress marker and §7.6 collapses its older updates. A part with nothing is left out.
// §12.3: the compact prompt of a too-long retry collapses every update and has no older updates.
export const reviewPrompt = (input: ReviewInput, options: { readonly isCompact?: boolean } = {}): string =>
  [
    ...part(
      'Your notes so far (newest first)',
      input.notes
        .toReversed()
        .map((note) => `- [${note.severity}] ${note.text} (${note.delivery})`)
        .join('\n')
    ),
    ...part(
      input.subagent === undefined
        ? "The person's prompts since the watchdog started (newest first)"
        : "The subagent's task",
      recapPrompts(input)
    ),
    ...part(
      'Earlier updates (newest first, one line for each tool call)',
      options.isCompact === true ? '' : recapUpdates(input)
    ),
    ...part(
      input.subagent === undefined ? 'Session update' : `Session update: subagent ${input.subagent}`,
      renderBatch(input.updates, options)
    ),
  ].join('\n\n');
