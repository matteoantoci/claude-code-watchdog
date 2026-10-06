import { ownContext } from '../agents/ids';
import { isOwnRow } from '../agents/self-review';
import { currentMode } from '../lifecycle/mode';
import { isPersonPrompt } from '../person';
import { currentFeed, recordRow, setFeed } from './feed';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook, PromptOrigin } from 'claude-code';

// §10: a person prompt is known by its `prompt.submit` origin. The engine appends the prompt's row while the
// submit runs, and in `-p` it stamps that row `unclassified` though the submit says `sdk` (live probe
// l3-headless-prompt). So a `prompt` row that enters during a person submit takes the submit's origin.
const memory: { submitting: PromptOrigin | undefined } = { submitting: undefined };

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
    const { submitting } = memory;
    setFeed(
      recordRow(currentFeed(), e.door === 'prompt' && submitting !== undefined ? { ...e, origin: submitting } : e)
    );
  }
  const result = await next(e);
  if (isRecorded) {
    await saveFeed($);
  }
  return result;
};

const onPersonPrompt: Hook<'prompt.submit'> = async (_$, e, next) => {
  if (!isPersonPrompt(e.origin)) {
    return next(e);
  }
  memory.submitting = e.origin;
  return next(e).finally(() => {
    memory.submitting = undefined;
  });
};

export const installFeed = (on: OnEvents<'session.append' | 'prompt.submit'>): void => {
  on('session.append', onAppend);
  on('prompt.submit', { origin: { kind: /./u } }, onPersonPrompt);
};
