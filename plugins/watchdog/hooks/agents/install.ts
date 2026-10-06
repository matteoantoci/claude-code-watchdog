import { rememberSpawnModel } from '../failure/state';
import { learnReviewAgent } from '../review/slots';
import { ownContext, watchdogIds } from './ids';
import { isOwnSpawn, isOwnToolCall } from './self-review';
import { TYPE_PREFIX } from './spec';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook, MatchedHook } from 'claude-code';

// §7.3: `$.state` keeps a copy of the id set, an array because a Set becomes `{}` in JSON. The live copy is
// module memory, so a refused write loses only what a reload would carry over.
const saveIds = async ($: EngineInterface): Promise<void> => {
  await $.state.set({ plugin: 'watchdog', key: 'ids' }, watchdogIds()).catch(() => undefined);
};

// The agent id in an `Agent` call's result record.
const agentIdOf = (record: unknown): string | undefined =>
  typeof record === 'object' && record !== null && 'agentId' in record && typeof record.agentId === 'string'
    ? record.agentId
    : undefined;

const learn = async ($: EngineInterface, subagentType: unknown, agentId: string | undefined): Promise<void> => {
  if (agentId !== undefined && isOwnSpawn(subagentType)) {
    learnReviewAgent(subagentType.slice(TYPE_PREFIX.length), agentId);
    await saveIds($);
  }
};

// §7.3: the id comes from the `next(e)` result of the mod's `agent.spawn` hook, before the spawn resolves.
// §12.2: so does the model that the agent runs on.
const onSpawn: Hook<'agent.spawn'> = async ($, e, next) => {
  const result = await next(e);
  if (result.agentId !== undefined) {
    rememberSpawnModel(result.agentId, result.model);
  }
  await learn($, e.subagentType, result.agentId);
  return result;
};

// §7.3: or from the `next(e)` result of the synthetic main-loop `Agent` call of the spawn.
const onAgentCall: MatchedHook<'tool.call', { tool: 'Agent' }> = async ($, e, next) => {
  if (e.agentId !== undefined || !isOwnToolCall(e, ownContext())) {
    return next(e);
  }
  const result = await next(e);
  const isAnswered = result.deny === undefined && result.isError !== true;
  await learn($, e.subagent_type, isAnswered ? agentIdOf(result.result) : undefined);
  return result;
};

// §6.1: hide each watchdog type from the model; the hide does not block the mod's own spawn.
export const installAgents = (on: OnEvents<'agent.offer' | 'agent.spawn' | 'tool.call'>): void => {
  on('agent.offer', { agent: /^watchdog:/u }, () => ({ isOffered: false })).catch((_$, e, next) =>
    next.called ? next(e) : { isOffered: false }
  );
  on('agent.spawn', { subagentType: /^watchdog:/u }, onSpawn);
  on('tool.call', { tool: 'Agent' }, onAgentCall);
};
