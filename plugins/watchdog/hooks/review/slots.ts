import { addWatchdogId } from '../agents/ids';
import { watchdogBySlug } from '../agents/roster';
import { setReviewTarget } from '../subagents/watch';
import type { Watchdog } from '../agents/roster';
import type { PluginState } from 'claude-code';

// §12.4: the problem states (their shape is the `health` key of the state contract). `no_model` and
// `blocked` make no review until `/watchdog on`; `limited` and `halted` try one review at a person prompt
// (§12.3), `halted` once its next-try time passed.
export type Problem = NonNullable<PluginState['watchdog']['health']['watchdogs'][string]['problem']>;

// §7.5, §12.4: each watchdog runs one review at a time. `reviewing` keeps the agent (null until its id
// arrives), the last row of its batch and, for a review of a subagent (§11.2), that subagent's `agentId`; a try
// keeps the problem it started from (§12.3), and the retry at once of a prompt too large is compact (§12.3 item 4).
// `disabled` is a roster entry with `enabled: false` (§4.2).
export type Slot =
  | { readonly state: 'idle' | 'disabled' }
  | {
      readonly state: 'reviewing';
      readonly agentId: string | null;
      readonly batchEnd: string;
      readonly subagent?: string;
      readonly from?: Problem;
      readonly isCompact?: boolean;
    }
  | Problem;

export const IDLE: Slot = { state: 'idle' };

const slots = new Map<string, Slot>();

export const slotOf = (slug: string): Slot => slots.get(slug) ?? IDLE;

export const setSlot = (slug: string, slot: Slot): void => {
  slots.set(slug, slot);
};

// The watchdog whose running review is this agent.
export const reviewOf = (agentId: string): string | undefined =>
  Array.from(slots).find(([, slot]) => slot.state === 'reviewing' && slot.agentId === agentId)?.[0];

// A running review: its agent, its slot and its watchdog.
export type RunningReview = {
  readonly agentId: string;
  readonly slot: Extract<Slot, { state: 'reviewing' }>;
  readonly watchdog: Watchdog;
};

// The running review of this agent; undefined for another agent.
export const runningReview = (agentId: string | undefined): RunningReview | undefined => {
  const slug = agentId === undefined ? undefined : reviewOf(agentId);
  const slot = slug === undefined ? undefined : slotOf(slug);
  const watchdog = slug === undefined ? undefined : watchdogBySlug(slug);
  return agentId === undefined || slot?.state !== 'reviewing' || watchdog === undefined
    ? undefined
    : { agentId, slot, watchdog };
};

// How a review starts: at a boundary when the cadence of a backlog is due (§7.4, §11.2); as the try of a
// `limited` or `halted` watchdog at a person prompt (§12.3 items 2, 3), which keeps the problem it starts from;
// or as the compact retry at once of a prompt too large (§12.3 item 4), which keeps the problem and the
// backlog (the subagent's `agentId`, none for the primary agent) of the review it repeats.
export type Start = { readonly from?: Problem; readonly isCompact?: boolean; readonly subagent?: string };

// Whether the watchdog can start a review this way now; the backlog it takes decides the rest (§7.5).
export const isReady = (slug: string, start: Start): boolean => {
  const slot = slotOf(slug);
  return start.from === undefined || start.isCompact === true ? slot.state === 'idle' : slot === start.from;
};

// §7.3: a review agent's id, from the first source that gives it; §11.4: the id maps to the subagent of a review
// of a subagent, and to none for a review of the primary agent.
export const learnReviewAgent = (slug: string, agentId: string): void => {
  const slot = slotOf(slug);
  if (slot.state === 'reviewing' && slot.agentId === null) {
    setSlot(slug, { ...slot, agentId });
    setReviewTarget(agentId, slot.subagent);
  }
  addWatchdogId(agentId, slug);
};

// §7.3, §16.2: a review runs whose agent's id no source gave yet.
export const isIdMissing = (): boolean =>
  Array.from(slots.values()).some((slot) => slot.state === 'reviewing' && slot.agentId === null);

// §5.2 steps 1, 2 and 5: `/watchdog on` tries each watchdog again; a running review keeps its slot, unless the
// roster now disables its watchdog.
const slotAfterOn = (
  slot: Slot,
  problems: { isDisabled: boolean; blocked: string | undefined; noModel: string | undefined }
): Slot => {
  if (problems.isDisabled) {
    return { state: 'disabled' };
  }
  if (slot.state === 'reviewing') {
    return slot;
  }
  if (problems.blocked !== undefined) {
    return { state: 'blocked', reason: problems.blocked };
  }
  return problems.noModel === undefined ? IDLE : { state: 'no_model', reason: problems.noModel };
};

// §5.2: the slot of each watchdog after `/watchdog on`, from its roster entry (§4.2, §6.2), the register
// problem of its slug and the preflight problem of its model. Returns the slugs that keep a feed cursor: a
// disabled, `no_model` or `blocked` watchdog makes no review until `/watchdog on` starts the feed again.
export const slotsAfterOn = (
  watchdogs: readonly Watchdog[],
  blocked: ReadonlyMap<string, string | undefined>,
  noModel: ReadonlyMap<string, string | undefined>
): string[] => {
  watchdogs.forEach((watchdog) => {
    const problems = {
      isDisabled: !watchdog.isEnabled,
      blocked: blocked.get(watchdog.slug),
      noModel: watchdog.noModel ?? noModel.get(watchdog.model),
    };
    setSlot(watchdog.slug, slotAfterOn(slotOf(watchdog.slug), problems));
  });
  return watchdogs
    .filter((watchdog) => ['idle', 'reviewing'].includes(slotOf(watchdog.slug).state))
    .map((watchdog) => watchdog.slug);
};

// The status line of one watchdog.
export const slotLine = (name: string, slot: Slot): string =>
  'reason' in slot ? `${name} ${slot.state}: ${slot.reason}` : `${name} ${slot.state}`;
