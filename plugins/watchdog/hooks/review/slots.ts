import { addWatchdogId } from '../agents/ids';

// §7.5, §12.4: each watchdog runs one review at a time. `reviewing` keeps the agent (null until its id
// arrives) and the last row of its batch. `no_model` and `blocked` make no review until `/watchdog on`.
// `disabled` is a roster entry with `enabled: false` (§4.2).
export type Slot =
  | { readonly state: 'idle' | 'disabled' }
  | { readonly state: 'reviewing'; readonly agentId: string | null; readonly batchEnd: string }
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

// §7.3: a review agent's id, from the first source that gives it.
export const learnReviewAgent = (slug: string, agentId: string): void => {
  const slot = slotOf(slug);
  if (slot.state === 'reviewing' && slot.agentId === null) {
    setSlot(slug, { ...slot, agentId });
  }
  addWatchdogId(agentId, slug);
};

// §5.2 steps 1, 2 and 5: `/watchdog on` tries each watchdog again; a running review keeps its slot, unless the
// roster now disables its watchdog.
export const slotAfterOn = (
  slot: Slot,
  problems: { isDisabled?: boolean; blocked?: string | undefined; noModel?: string | undefined }
): Slot => {
  if (problems.isDisabled === true) {
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

// The status line of one watchdog.
export const slotLine = (name: string, slot: Slot): string =>
  'reason' in slot ? `${name} ${slot.state}: ${slot.reason}` : `${name} ${slot.state}`;
