import { isOwnSpawn } from './self-review';
import type { OwnContext } from './self-review';
import type { AgentInfo, PluginState } from 'claude-code';

// §7.3: one known review agent and the watchdog it reviews for; `$.state` key `ids` keeps them as an array.
export type WatchdogId = PluginState['watchdog']['ids'][number];

// §7.3: the watchdog id set (agentId → watchdog slug) only grows for the life of the process, and the
// in-flight spawn window is a count of the mod's `$.agent.spawn` calls that have not settled.
const ids = new Map<string, string>();
const spawns = { inFlight: 0 };

export const addWatchdogId = (agentId: string, watchdog: string): void => {
  ids.set(agentId, watchdog);
};

export const watchdogOf = (agentId: string | undefined): string | undefined =>
  agentId === undefined ? undefined : ids.get(agentId);

export const watchdogIds = (): WatchdogId[] => Array.from(ids, ([agentId, watchdog]) => ({ agentId, watchdog }));

export const beginSpawn = (): void => {
  spawns.inFlight += 1;
};

export const endSpawn = (): void => {
  spawns.inFlight -= 1;
};

export const ownContext = (): OwnContext => ({ ids, isSpawnInFlight: spawns.inFlight > 0 });

// §7.3: the agent ids that the `$.agent.list()` cross-check found not the mod's; a "yes" joins the id set.
const notOwn = new Set<string>();

// §7.3: an id that the cross-check may answer: no spawn source gave it, the list did not say "no" for it, and
// every spawn of the mod settled.
export const needsCrossCheck = (agentId: string): boolean =>
  !ids.has(agentId) && !notOwn.has(agentId) && spawns.inFlight === 0;

// §7.3, §16.4 check 2: the `watchdog:<slug>` type of an agent that `$.agent.list()` shows `spawnedBy` the mod
// (never the type alone), else undefined. A "no" is kept only while no spawn is in flight, and not for an agent of
// a watchdog type, whose `spawnedBy` shows only after its spawn resolved.
export const crossCheck = (agentId: string, agents: readonly AgentInfo[]): string | undefined => {
  const agent = agents.find((entry) => entry.id === agentId);
  const type = agent?.spawnedBy === 'watchdog' ? agent.type : undefined;
  if (!isOwnSpawn(type) && spawns.inFlight === 0 && !isOwnSpawn(agent?.type)) {
    notOwn.add(agentId);
  }
  return isOwnSpawn(type) ? type : undefined;
};
