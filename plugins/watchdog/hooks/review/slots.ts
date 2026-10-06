import { addWatchdogId } from '../agents/ids';
import { setReviewTarget } from '../subagents/watch';
import type { Watchdog } from '../agents/roster';

// §7.5, §12.4: each watchdog runs one review at a time. `reviewing` keeps the agent (null until its id
// arrives), the last row of its batch and, for a review of a subagent (§11.2), that subagent's `agentId`.
// `no_model` and `blocked` make no review until `/watchdog on`. `disabled` is a roster entry with
// `enabled: false` (§4.2).
export type Slot =
  | { readonly state: 'idle' | 'disabled' }
  | {
      readonly state: 'reviewing';
      readonly agentId: string | null;
      readonly batchEnd: string;
      readonly subagent?: string;
    }
  | { readonly state: 'no_model' | 'blocked'; readonly reason: string };

export const IDLE: Slot = { state: 'idle' };

const slots = new Map<string, Slot>();

export const slotOf = (slug: string): Slot => slots.get(slug) ?? IDLE;

export const setSlot = (slug: string, slot: Slot): void => {
  slots.set(slug, slot);
};

// The watchdog whose running review is this agent.
export const reviewOf = (agentId: string): string | undefined =>
  Array.from(slots).find(([, slot]) => slot.state === 'reviewing' && slot.agentId === agentId)?.[0];

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
