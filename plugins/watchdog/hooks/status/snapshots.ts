import { STATUS_SNAPSHOT_CAP } from '../constants';
import type { StatusTable } from './table';

// §13.3: the table is a snapshot taken when the command runs. The `CommandOutput` render does not know the
// run, so a snapshot waits until the first render of an unknown row with its reply text takes it; that row
// keeps it for each redraw. Module memory: after a reload the engine draws the reply text.
const waiting: StatusTable[] = [];
const taken = new Map<string, StatusTable>();

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
  const index = waiting.findIndex((table) => table.text === text);
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
