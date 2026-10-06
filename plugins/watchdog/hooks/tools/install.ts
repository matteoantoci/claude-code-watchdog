import { ownContext, watchdogOf } from '../agents/ids';
import { watchdogBySlug } from '../agents/roster';
import { isOwnToolCall } from '../agents/self-review';
import { addStatusLines } from '../command/status';
import { guardDeny } from './guard';
import {
  addDeny,
  allowCall,
  allowSet,
  denyCounts,
  isAllowed,
  isScopeLoaded,
  isScopedCheck,
  readScopeDeny,
  restoreScope,
  scopeKey,
  toolArguments,
} from './scope';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook, MatchedHook } from 'claude-code';

// The tools of the recorder are a RegExp, because the tool table of 2.1.290 has no Grep or Glob: the main
// loop lacks them, and a subagent that lists them gets them (§6.3).
type GuardHook = MatchedHook<'tool.call', { agentId: RegExp }>;
type ReadHook = MatchedHook<'tool.call', { tool: RegExp }>;

// §6.5 item 8: a reload empties module memory, so the load (this module instance's `session.start`), or else the
// first hook that needs the allow set or the deny counts, reads them back from `$.state` once; a refused read
// leaves them empty. After a session change (§14.3) the new `$.state` holds neither, and nothing is read back.
const loading: { scope?: Promise<void> } = {};

const loadScope = async ($: EngineInterface): Promise<void> => {
  if (isScopeLoaded()) {
    return;
  }
  loading.scope ??= Promise.all([
    $.state.get({ plugin: 'watchdog', key: 'allow' }),
    $.state.get({ plugin: 'watchdog', key: 'denies' }),
  ]).then(
    ([allow, denies]) => {
      restoreScope(allow.value, denies.value);
    },
    () => undefined
  );
  await loading.scope;
};

// §6.4: a review agent runs only its watchdog's tools; a fork the watchdog plugin raised runs nothing.
// The answer comes before `next(e)`, so the permission check never runs and no dialog shows.
const onGuard: GuardHook = async (_$, e, next) => {
  const slug = watchdogOf(e.agentId);
  const tools = slug === undefined ? undefined : (watchdogBySlug(slug)?.tools ?? []);
  const deny = guardDeny(e.tool, tools, next.origin.plugin === 'watchdog');
  return deny === undefined ? next(e) : { deny };
};

// §6.5 item 4: an engine Read, Grep or Glob of the primary agent or of any subagent, with a result that
// is not an error, enters the allow set. The watchdog's own calls never do.
const onRead: ReadHook = async ($, e, next) => {
  const result = await next(e);
  const isRecorded =
    next.origin.plugin === 'engine' &&
    !isOwnToolCall(e, ownContext(), next.origin.plugin) &&
    result.deny === undefined &&
    result.isError !== true;
  const key = isRecorded ? scopeKey(e.tool, toolArguments(e)) : undefined;
  if (key !== undefined) {
    await loadScope($);
    allowCall(key);
    await $.state.set({ plugin: 'watchdog', key: 'allow' }, allowSet()).catch(() => undefined);
  }
  return result;
};

// §6.5 items 1-3, 6-8: an engine `allow` or `deny` of a watchdog call stands; an `ask` becomes `allow` for
// a call in the allow set, else a deny that the watchdog's count records.
const onCheck: Hook<'tool.check'> = async ($, e, next) => {
  const verdict = await next(e);
  const slug = watchdogOf(e.agentId);
  if (verdict.decision !== 'ask' || !isScopedCheck(e.tool, next.origin.plugin, slug !== undefined)) {
    return verdict;
  }
  await loadScope($);
  const key = scopeKey(e.tool, e.input);
  if (key !== undefined && isAllowed(key)) {
    return { decision: 'allow' };
  }
  if (slug !== undefined) {
    addDeny(slug);
    await $.state.set({ plugin: 'watchdog', key: 'denies' }, denyCounts()).catch(() => undefined);
  }
  return { decision: 'deny', reason: readScopeDeny(e.tool, e.input) };
};

// §6.5 items 7, 8: the deny counts come back at load, so `/watchdog status` shows them before any scoped call.
const onSessionStart: Hook<'session.start'> = async ($, e, next) => {
  const result = await next(e);
  await loadScope($);
  return result;
};

// §8.3: the 2.1.290 `.catch` forms. A failed guard denies only a call of a watchdog agent or a fork; a
// failed read-scope check denies only a call the watchdog plugin raised.
export const installTools = (on: OnEvents<'tool.call' | 'tool.check' | 'session.start'>): void => {
  on('tool.call', { agentId: /^/u }, onGuard).catch((_$, e, next) =>
    next.called || next.origin.plugin !== 'watchdog' || e.agentId === undefined
      ? next(e)
      : { deny: 'The watchdog tool guard failed.' }
  );
  on('tool.call', { tool: /^(?:Read|Grep|Glob)$/u }, onRead);
  on('tool.check', onCheck).catch((_$, e, next) =>
    isScopedCheck(e.tool, next.origin.plugin, false) ? { decision: 'deny' } : next(e)
  );
  on('session.start', { cwd: /^/u }, onSessionStart);
  // §6.5 item 7: one line for each watchdog with a read-scope deny in this session; none means 0.
  addStatusLines(() =>
    Object.entries(denyCounts()).map(
      ([slug, count]) => `${watchdogBySlug(slug)?.name ?? slug} read-scope denies: ${count}`
    )
  );
};
