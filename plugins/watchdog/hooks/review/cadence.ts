import type { Watchdog } from '../agents/roster';

// §7.4: the eligible updates a watchdog has seen since `/watchdog on`, and whether a review is due. Updates
// that the interval skips wait in the backlog and go with the next review (§7.5).
export type Cadence = { readonly eligible: number; readonly isDue: boolean };

export const NO_BOUNDARY: Cadence = { eligible: 0, isDue: false };

// §7.4: `turn` counts each boundary, `agent-end` only the end of a turn; every Nth eligible update makes a
// review due. A due review that has not run stays due.
export const countBoundary = (
  cadence: Cadence,
  watchdog: Pick<Watchdog, 'reviewMode' | 'reviewInterval'>,
  isTurnEnd: boolean
): Cadence => {
  if (watchdog.reviewMode === 'agent-end' && !isTurnEnd) {
    return cadence;
  }
  const eligible = cadence.eligible + 1;
  return { eligible, isDue: cadence.isDue || eligible % watchdog.reviewInterval === 0 };
};

// The cadence of each watchdog slug, in module memory; `/watchdog on` starts it again.
const cadences = new Map<string, Cadence>();

export const cadenceOf = (slug: string): Cadence => cadences.get(slug) ?? NO_BOUNDARY;

export const setCadence = (slug: string, cadence: Cadence): void => {
  cadences.set(slug, cadence);
};

export const resetCadences = (): void => {
  cadences.clear();
};
