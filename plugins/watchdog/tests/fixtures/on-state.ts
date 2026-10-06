// Stubs for the on-state sources of an L2 test (spec §5.1): the `$.state` key `on` and the Desktop events.
// Use with `stubSession` of ./session, which stubs the session id and the `$.store`.
import { SESSION_ID } from './session';
import type { OnEvents } from '../../hooks/on';
import type { SessionStubs } from './session';
import type { SessionStartInput } from 'claude-code';

export type OnStateStubs = SessionStubs & OnEvents<'state.get' | 'state.set' | 'session.attach' | 'prompt.submit'>;

export type OnStateSeen = {
  // Each `$.state` value written under `on`, oldest first.
  onWrites: unknown[];
};

// The `$.store` key of the on flag.
export const ON_STORE_KEY = `on:${SESSION_ID}`;

// The `store` option of `stubSession`: the `$.store` value of `on:<SESSION_ID>` at load.
export const storedOn = (flag: unknown): ReadonlyMap<string, unknown> => new Map([[ON_STORE_KEY, flag]]);

// §5.3: Desktop `session.start` matches `-p`.
export const DESKTOP_START: SessionStartInput = { cwd: '/repo', surface: null, isInteractive: false };

export const DESKTOP_ATTACH = { surface: 'desktop', clientId: 'desktop:default' } as const;

export const PROMPT = { text: 'fix the bug', wait: false, origin: { kind: 'composer' } } as const;

// `state` is the `$.state` value of `on` at load (a reload).
export const stubOnState = (on: OnStateStubs, seed: { state?: unknown } = {}): OnStateSeen => {
  const seen: OnStateSeen = { onWrites: [] };
  on('state.get', (_$, e) => ({
    value: { value: e.key === 'on' ? (seen.onWrites.at(-1) ?? seed.state) : undefined, version: 0 },
  }));
  on('state.set', (_$, e) => {
    if (e.key === 'on') {
      seen.onWrites.push(e.value);
    }
    return { value: { isSet: true, version: 1 } };
  });
  on('session.attach', (_$, e) => ({ clientId: e.clientId }));
  on('prompt.submit', (_$, e) => ({ text: e.text }));
  return seen;
};
