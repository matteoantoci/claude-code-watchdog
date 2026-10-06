import { watchdogOf } from '../agents/ids';
import { watchdogBySlug } from '../agents/roster';
import { subagentOfReview } from '../subagents/watch';
import { addLogRecord, countStep, currentLog, reviewRecord, takeTrace } from './log';
import type { OnEvents } from '../on';
import type { EngineInterface, TurnCompleteInput } from 'claude-code';

// §13.4, §14.1: one record for each review, at the review agent's own `turn.complete`; `$.state` keeps
// the log across a reload, so a refused write loses only that carry-over.
const logReview = async ($: EngineInterface, end: TurnCompleteInput): Promise<void> => {
  const slug = watchdogOf(end.agentId);
  const watchdog = slug === undefined ? undefined : watchdogBySlug(slug);
  if (watchdog === undefined || end.agentId === undefined) {
    return;
  }
  const time = await $.clock.now();
  const watch = subagentOfReview(end.agentId);
  const subagent = watch === undefined ? undefined : { agentId: watch.agentId, type: watch.type };
  addLogRecord(reviewRecord({ watchdog, agentId: end.agentId, time, end, trace: takeTrace(end.agentId), subagent }));
  await $.state.set({ plugin: 'watchdog', key: 'log' }, currentLog());
};

// §12.1, §7.2: the review agent's steps are counted in a registration that did not spawn it (the spawning
// `on('turn.step')` never sees them). The matchers only tell these `on()` from the review area's.
export const installLog = (on: OnEvents<'turn.step' | 'turn.complete'>): void => {
  on('turn.step', { turnId: /^/u }, async function* (_$, e, next) {
    if (e.agentId !== undefined && watchdogOf(e.agentId) !== undefined) {
      countStep(e.agentId);
    }
    return yield* next(e);
  });
  on('turn.complete', { turnId: /^/u }, async ($, e, next) => {
    const result = await next(e);
    await logReview($, e).catch(() => undefined);
    return result;
  });
};
