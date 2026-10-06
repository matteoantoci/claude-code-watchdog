import type { OwnContext } from './self-review';
import type { PluginState } from 'claude-code';

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
