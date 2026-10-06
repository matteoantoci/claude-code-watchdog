import { BAND_LINE_COLUMNS, MINUTE_MS } from '../constants';
import type { Problem } from '../review/slots';

// §12.5: one watchdog in a problem state, by its display name.
export type Trouble = { readonly name: string; readonly problem: Problem };

export type TroubleView = {
  readonly now: number;
  readonly columns: number;
  // The roster has one watchdog, so the line need not name it.
  readonly isAlone: boolean;
};

// §12.5: the most serious state first.
const RANK: Readonly<Record<Problem['state'], number>> = { blocked: 0, no_model: 1, halted: 2, limited: 3 };

// §12.3 item 2: the try of a halt comes at the first person prompt after its next-try time.
const retry = (problem: Problem, now: number): string => {
  const minutes = problem.state === 'halted' ? Math.ceil((problem.nextTryAt - now) / MINUTE_MS) : 0;
  return minutes > 0 ? `retry in ${minutes} min` : 'retry at the next prompt';
};

// §12.5: the line of a single watchdog in trouble, with what the person can do.
const single = ({ name, problem }: Trouble, view: TroubleView): string => {
  const who = view.isAlone && problem.state === 'halted' ? 'watchdog' : `watchdog: ${name}`;
  const hints: Readonly<Record<Problem['state'], string>> = {
    halted: `${retry(problem, view.now)} · /watchdog on to retry now`,
    limited: retry(problem, view.now),
    no_model: 'fix WATCHDOG.json, then /watchdog on',
    blocked: '/watchdog status, then /watchdog on',
  };
  return `${who} ${problem.state} · ${hints[problem.state]}`;
};

// §12.5: the red band line while any watchdog is in trouble; undefined when none is. Below 80 `bodyColumns`
// it only counts them.
export const troubleLine = (troubles: readonly Trouble[], view: TroubleView): string | undefined => {
  const sorted = troubles.toSorted((a, b) => RANK[a.problem.state] - RANK[b.problem.state]);
  const [first] = sorted;
  if (first === undefined) {
    return undefined;
  }
  if (view.columns < BAND_LINE_COLUMNS) {
    return `watchdog: ${sorted.length} problem${sorted.length === 1 ? '' : 's'} · /watchdog status`;
  }
  // §12.5: one short part for each watchdog in a line of several.
  const parts = sorted.map(({ name, problem }) =>
    problem.state === 'halted' ? `${name} halted · ${retry(problem, view.now)}` : `${name} ${problem.state}`
  );
  return sorted.length === 1 ? single(first, view) : `watchdog: ${parts.join(' · ')} · /watchdog status`;
};
