import { ownContext } from '../agents/ids';
import { isOwnRow } from '../agents/self-review';
import { currentMode } from '../lifecycle/mode';
import { currentFeed, recordRow, setFeed } from './feed';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook } from 'claude-code';

// §7.1: `$.state` keeps the feed. The live copy is module memory, so a refused write (a value over
// 4,194,304 characters of JSON) loses only what a reload would carry over.
const saveFeed = async ($: EngineInterface): Promise<void> => {
  await $.state.set({ plugin: 'watchdog', key: 'feed' }, currentFeed()).catch(() => undefined);
};

// §7.1: while on, each main-loop row enters the feed rendered (§7.6), except the watchdog's own rows (§7.3).
// A row with an `agentId` never enters the primary agent's feed. The row is kept before `next(e)`, which
// the hook relays.
const onAppend: Hook<'session.append'> = async ($, e, next) => {
  const isRecorded = currentMode() === 'on' && e.agentId === undefined && !isOwnRow(e, ownContext());
  if (isRecorded) {
    setFeed(recordRow(currentFeed(), e));
  }
  const result = await next(e);
  if (isRecorded) {
    await saveFeed($);
  }
  return result;
};

export const installFeed = (on: OnEvents<'session.append'>): void => {
  on('session.append', onAppend);
};
