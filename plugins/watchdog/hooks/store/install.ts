import { errorText } from '../errors';
import { refusedWrite } from '../failure/state';
import { claimPrune, prunedKeys } from './prune';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook } from 'claude-code';

// §14.2: a refused write shows as `last error`, and in one `$.ui.log` row for each session.
const showRefused = async ($: EngineInterface, refusal: string): Promise<void> => {
  const row = refusedWrite(await $.session.id().catch(() => ''), refusal);
  if (row !== undefined) {
    $.ui.log(row);
  }
};

// §14.2: each `$.state.set` and `$.store.set` of the mod passes here; a deny or a throw beneath is its reject.
// The caller still gets the reject and keeps its live copy.
const onStateSet: Hook<'state.set'> = async ($, e, next) => {
  const result = await next(e).catch((error: unknown) => ({ deny: errorText(error) }));
  if ('deny' in result && next.origin.plugin === 'watchdog') {
    await showRefused($, `$.state ${e.key} not saved: ${result.deny}`);
  }
  return result;
};

// §14.2: once for each session, before its first write, the store keeps the keys of the 50 newest sessions; a
// read or delete that fails leaves the rest for the next session's prune.
const pruneStore = async ($: EngineInterface): Promise<void> => {
  const sessionId = await $.session.id();
  if (!claimPrune(sessionId)) {
    return;
  }
  const keys = await $.store.keys();
  const entries = await Promise.all(keys.map(async (key) => [key, await $.store.get(key)] as const));
  await Promise.all(prunedKeys(entries, sessionId).map(async (key) => $.store.delete(key)));
};

const onStoreSet: Hook<'store.set'> = async ($, e, next) => {
  if (next.origin.plugin !== 'watchdog') {
    return next(e);
  }
  await pruneStore($).catch(() => undefined);
  const result = await next(e).catch((error: unknown) => ({ deny: errorText(error) }));
  if ('deny' in result) {
    await showRefused($, `$.store ${e.key} not saved: ${result.deny}`);
  }
  return result;
};

export const installStore = (on: OnEvents<'state.set' | 'store.set'>): void => {
  on('state.set', onStateSet);
  on('store.set', onStoreSet);
};
