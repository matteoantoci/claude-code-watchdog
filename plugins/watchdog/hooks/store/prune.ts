// §14.2: the `$.store` prune. Pure: the store area's hook reads the store and deletes the keys.
import { STORE_SESSION_CAP } from '../constants';

// §14.2: `on:<sessionId>`, `notes:<sessionId>` and `notes:<sessionId>:<agentId>`; the session id is group 1 or 2.
const SESSION_KEY = /^(?:on:([^:]+)|notes:([^:]+)(?::[^:]+)?)$/u;

const sessionOf = (key: string): string | undefined => {
  const match = SESSION_KEY.exec(key);
  return match?.[1] ?? match?.[2];
};

const lastUsedOf = (value: unknown): number =>
  typeof value === 'object' && value !== null && 'lastUsed' in value && typeof value.lastUsed === 'number'
    ? value.lastUsed
    : 0;

// §14.2: the keys to delete so that the store keeps the 50 newest sessions, each session as new as the newest
// `lastUsed` of its keys. The session that writes now is the newest. A key of another shape stays.
export const prunedKeys = (entries: readonly (readonly [string, unknown])[], sessionId: string): string[] => {
  const newest = new Map<string, number>();
  entries.forEach(([key, value]) => {
    const session = sessionOf(key);
    if (session !== undefined) {
      newest.set(session, Math.max(newest.get(session) ?? 0, lastUsedOf(value)));
    }
  });
  newest.set(sessionId, Number.POSITIVE_INFINITY);
  const kept = new Set(
    [...newest]
      .toSorted(([, a], [, b]) => b - a)
      .slice(0, STORE_SESSION_CAP)
      .map(([session]) => session)
  );
  return entries.flatMap(([key]) => {
    const session = sessionOf(key);
    return session === undefined || kept.has(session) ? [] : [key];
  });
};

// §14.2: the session ids whose first write pruned the store, in module memory; a reload prunes once more.
const pruned = new Set<string>();

// True at the first write of a session.
export const claimPrune = (sessionId: string): boolean => {
  if (pruned.has(sessionId)) {
    return false;
  }
  pruned.add(sessionId);
  return true;
};
