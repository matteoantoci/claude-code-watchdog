import { STATUS_SNAPSHOT_CAP } from '../constants';
import type { StatusTable } from './table';

// §13.3: the table is a snapshot taken when the command runs. The `CommandOutput` render does not know the
// run, so a snapshot waits until the first render of an unknown row with its reply text takes it; that row
// keeps it for each redraw. Module memory: after a reload the engine draws the reply text.
const waiting: StatusTable[] = [];
const taken = new Map<string, StatusTable>();

// d.ts `CommandOutput` `text`: the engine draws the `text` a hook answered under its plugin's name, joined by `+`
// with each other plugin whose `command.run` hook the run passed (live probe l3-status-table:
// `wdprobe+watchdog: watchdog on · …`).
const ANSWERED_BY = /^(?<names>[^\s:]+): /u;

// The reply inside an output row's text: the text without the plugin names, when they name this plugin.
export const replyOf = (text: string): string => {
  const names = ANSWERED_BY.exec(text)?.groups?.names;
  return names?.split('+').includes('watchdog') === true ? text.replace(ANSWERED_BY, '') : text;
};

export const queueSnapshot = (table: StatusTable): void => {
  waiting.push(table);
  waiting.splice(0, waiting.length - STATUS_SNAPSHOT_CAP);
};

// The snapshot of the row `requestId` that shows `text`; undefined for a row of no known run.
export const snapshotFor = (requestId: string, text: string): StatusTable | undefined => {
  const known = taken.get(requestId);
  if (known !== undefined) {
    return known;
  }
  const reply = replyOf(text);
  const index = waiting.findIndex((table) => table.text === reply);
  const [table] = index === -1 ? [] : waiting.splice(index, 1);
  if (table === undefined) {
    return undefined;
  }
  taken.set(requestId, table);
  const oldest = taken.size > STATUS_SNAPSHOT_CAP ? taken.keys().next().value : undefined;
  if (oldest !== undefined) {
    taken.delete(oldest);
  }
  return table;
};
