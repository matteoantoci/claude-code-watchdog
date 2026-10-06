// Stubs for an L2 test of the delivery routes (spec §10): a watched session on a clock the test moves, the
// prompts that reach the engine (the person's and the mod's nudge), and the main-loop `turn.start`.
import { mock } from 'claude-code/testing';
import { GUIDANCE, NOW, REVIEW_AGENT, START, stubSession, typed } from './session';
import type { OnEvents } from '../../hooks/on';
import type { Seen, SessionEvents } from './session';
import type { AgentSpawnInput, PromptSubmitInput } from 'claude-code';
import type { Engine, MockClock } from 'claude-code/testing';

export type DeliveryEvents = SessionEvents | 'prompt.submit' | 'turn.start';

export type DeliveryStubs = OnEvents<DeliveryEvents>;

export type DeliverySeen = Seen & {
  readonly clock: MockClock;
  // Each prompt as it reached the engine, after the mod's hooks: `context` is what the model reads with it.
  readonly prompts: PromptSubmitInput[];
};

// The engine's `agent.spawn` of a review, as the Agent tool fires it: the mod learns the id from `next(e)`.
export const REVIEW_SPAWN: AgentSpawnInput = {
  tool_use_id: 'toolu_plugin_00000000000000000000000000000001',
  prompt: 'review',
  description: 'watchdog default review',
  subagentType: 'watchdog:default',
  provider: { plugin: 'watchdog', tier: 'user' },
  parentModel: 'claude-opus-4-5',
  background: true,
  fork: false,
};

// §10: the kit stamps no origin, so each prompt names its own.
export const PERSON_PROMPT = { text: 'Fix the parser.', wait: false, origin: { kind: 'composer' } } as const;

export const TASK_NOTIFICATION = {
  text: '<task-notification><task-id>bsub0001</task-id>done</task-notification>',
  wait: false,
  origin: { kind: 'task-notification' },
} as const;

// §10.3: the `turn.start` text of the mod's own nudge turn.
export const nudgeTurnText = (nudge: string): string => `The watchdog plugin sent a message:\n${nudge}`;

// §10.7: the wrapper with the fixture's boundary guidance around the given `<note>` elements.
export const wrapped = (...notes: string[]): string =>
  ['<watchdog-notes>', GUIDANCE.trim(), ...notes, '</watchdog-notes>'].join('\n');

export const stubDelivery = (on: DeliveryStubs, options: Parameters<typeof stubSession>[1] = {}): DeliverySeen => {
  const clock = mock.clock(on, { now: NOW });
  const seen = stubSession(on, { ...options, isClockMocked: true });
  const prompts: PromptSubmitInput[] = [];
  on('prompt.submit', (_$, e) => {
    prompts.push(e);
    return { text: e.text };
  });
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  return { ...seen, clock, prompts };
};

// `/watchdog on`, then the review agent's id as the engine's `agent.spawn` gives it.
export const startReview = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await $.agent.spawn(REVIEW_SPAWN);
};

export const sendNote = async ($: Engine, severity: string, note: string): Promise<void> => {
  await $.tool.call({ tool: 'mcp__watchdog__note', agentId: REVIEW_AGENT, note, severity });
};
