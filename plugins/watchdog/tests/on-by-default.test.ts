import { describe, expect, test } from 'claude-code/testing';
import { DESKTOP_DROP_WARNING } from '../hooks/lifecycle/on-order';
import { DESKTOP_ATTACH, DESKTOP_START, PROMPT, SESSION_ID, stubOnState } from './fixtures/on-state';
import { START, stubSession, typed } from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { OnStateStubs } from './fixtures/on-state';

// The `$` calls of `/watchdog dump` on the Desktop: no clipboard, so only the file.
type DumpStubs = OnStateStubs & OnEvents<'env.get' | 'session.surfaces' | 'fs.write'>;

const ON_BY_DEFAULT = { options: { onByDefault: true } };
const STORE_KEY = `on:${SESSION_ID}`;
const BY_COMMAND = { isOn: true, source: '/watchdog on' } as const;
const BY_ENV = { isOn: true, source: 'CLAUDE_WATCHDOG' } as const;

describe('on order at session.start', () => {
  test(
    'onByDefault turns an interactive session on, after the version gate',
    ON_BY_DEFAULT,
    async ($, on: OnStateStubs) => {
      const seen = stubSession(on);
      const state = stubOnState(on);
      await $.session.start(START);
      const status = await $.command.run(typed('status'));
      expect(status.text).toBe('watchdog on\non source: onByDefault\ndefault idle');
      expect(seen.agents.map((agent) => agent.name)).toEqual(['default']);
      expect(seen.preflights).toHaveLength(1);
      expect(state.onWrites).toEqual([{ isOn: true, source: 'onByDefault' }]);
    }
  );

  test('without onByDefault the session stays off and writes no on flag', async ($, on: OnStateStubs) => {
    const seen = stubSession(on);
    const state = stubOnState(on);
    await $.session.start(START);
    expect((await $.command.run(typed('status'))).text).toBe('watchdog off');
    expect(seen.agents).toEqual([]);
    expect(state.onWrites).toEqual([]);
  });

  test('the stored on:<sessionId> flag wins over onByDefault', ON_BY_DEFAULT, async ($, on: OnStateStubs) => {
    stubSession(on);
    stubOnState(on, { stored: { isOn: false, lastUsed: 1 } });
    await $.session.start(START);
    expect((await $.command.run(typed('status'))).text).toBe('watchdog off');
  });

  test('a new process restores the stored on flag with its source', async ($, on: OnStateStubs) => {
    stubSession(on);
    stubOnState(on, { stored: { ...BY_COMMAND, lastUsed: 1 } });
    await $.session.start(START);
    expect((await $.command.run(typed('status'))).text).toBe('watchdog on\non source: /watchdog on\ndefault idle');
  });

  test(
    'the $.state flag of a reload wins over the stored flag and onByDefault, also a false',
    ON_BY_DEFAULT,
    async ($, on: OnStateStubs) => {
      const seen = stubSession(on);
      stubOnState(on, { state: { isOn: false }, stored: { ...BY_COMMAND, lastUsed: 1 } });
      await $.session.start(START);
      expect((await $.command.run(typed('status'))).text).toBe('watchdog off');
      expect(seen.agents).toEqual([]);
    }
  );

  test(
    'a headless session keeps the $.state flag and ignores the stored flag and onByDefault',
    ON_BY_DEFAULT,
    async ($, on: OnStateStubs) => {
      stubSession(on);
      stubOnState(on, { stored: { ...BY_COMMAND, lastUsed: 1 } });
      await $.session.start({ cwd: '/repo', surface: null, isInteractive: false });
      expect((await $.command.run(typed('status'))).text).toBe('watchdog off');
    }
  );

  test('/watchdog on and off store the flag under on:<sessionId>', async ($, on: OnStateStubs) => {
    stubSession(on);
    const state = stubOnState(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    expect(state.store.get(STORE_KEY)).toEqual({ ...BY_COMMAND, lastUsed: expect.any(Number) });
    await $.command.run(typed('off'));
    expect(state.store.get(STORE_KEY)).toEqual({ isOn: false, lastUsed: expect.any(Number) });
  });
});

describe('Desktop attach', () => {
  test('a desktop attach before the first prompt applies onByDefault', ON_BY_DEFAULT, async ($, on: OnStateStubs) => {
    const seen = stubSession(on);
    stubOnState(on);
    await $.session.start(DESKTOP_START);
    expect((await $.command.run(typed('status'))).text).toBe('watchdog off');
    await $.session.attach(DESKTOP_ATTACH);
    expect((await $.command.run(typed('status'))).text).toBe('watchdog on\non source: onByDefault\ndefault idle');
    expect(seen.preflights).toHaveLength(1);
  });

  test('an attach after the first prompt changes nothing', ON_BY_DEFAULT, async ($, on: OnStateStubs) => {
    stubSession(on);
    stubOnState(on);
    await $.session.start(DESKTOP_START);
    await $.prompt.submit(PROMPT);
    await $.session.attach(DESKTOP_ATTACH);
    expect((await $.command.run(typed('status'))).text).toBe('watchdog off');
  });

  test(
    'the attach drops an on state from CLAUDE_WATCHDOG with a dump warning; the stored flag wins',
    ON_BY_DEFAULT,
    async ($, on: DumpStubs) => {
      stubSession(on);
      const state = stubOnState(on, { state: BY_ENV, stored: { isOn: false, lastUsed: 1 } });
      const dumps: string[] = [];
      on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }));
      on('session.surfaces', () => ({ value: ['desktop'] as const }));
      on('fs.write', (_$, e) => {
        dumps.push(e.text);
        return { value: undefined };
      });
      await $.session.start(DESKTOP_START);
      expect((await $.command.run(typed('status'))).text).toBe('watchdog on\non source: CLAUDE_WATCHDOG\ndefault idle');
      await $.session.attach(DESKTOP_ATTACH);
      expect((await $.command.run(typed('status'))).text).toBe('watchdog off');
      expect(state.onWrites.at(-1)).toEqual({ isOn: false });
      await $.command.run(typed('dump'));
      expect(dumps[0]).toContain(`warning: ${DESKTOP_DROP_WARNING}`);
    }
  );

  test(
    'after the drop, onByDefault keeps the session on with its own source',
    ON_BY_DEFAULT,
    async ($, on: OnStateStubs) => {
      const seen = stubSession(on);
      stubOnState(on, { state: BY_ENV });
      await $.session.start(DESKTOP_START);
      await $.session.attach(DESKTOP_ATTACH);
      expect((await $.command.run(typed('status'))).text).toBe('watchdog on\non source: onByDefault\ndefault idle');
      expect(seen.preflights).toHaveLength(1);
    }
  );
});
