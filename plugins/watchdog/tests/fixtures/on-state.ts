// Stubs for the on-state sources of an L2 test (spec §5.1): the `$.state` key `on`, the `$.store`, the
// session id, and the Desktop events. Use with `stubSession` of ./session.
import type { OnEvents } from '../../hooks/on';
import type { SessionStubs } from './session';
import type { SessionStartInput } from 'claude-code';

export type OnStateStubs = SessionStubs &
  OnEvents<'state.get' | 'state.set' | 'session.id' | 'store.get' | 'store.set' | 'session.attach' | 'prompt.submit'>;

export type OnStateSeen = {
  // Each `$.state` value written under `on`, oldest first.
  onWrites: unknown[];
  // The `$.store`, key → value.
  store: Map<string, unknown>;
};

export const SESSION_ID = 's1';

// §5.3: Desktop `session.start` matches `-p`.
export const DESKTOP_START: SessionStartInput = { cwd: '/repo', surface: null, isInteractive: false };

export const DESKTOP_ATTACH = { surface: 'desktop', clientId: 'desktop:default' } as const;

export const PROMPT = { text: 'fix the bug', wait: false, origin: { kind: 'composer' } } as const;

// `state` is the `$.state` value of `on` at load (a reload); `stored` the `$.store` value of
// `on:<SESSION_ID>` at load.
export const stubOnState = (on: OnStateStubs, seed: { state?: unknown; stored?: unknown } = {}): OnStateSeen => {
  const seen: OnStateSeen = { onWrites: [], store: new Map([[`on:${SESSION_ID}`, seed.stored]]) };
  on('state.get', (_$, e) => ({
    value: { value: e.key === 'on' ? (seen.onWrites.at(-1) ?? seed.state) : undefined, version: 0 },
  }));
  on('state.set', (_$, e) => {
    if (e.key === 'on') {
      seen.onWrites.push(e.value);
    }
    return { value: { isSet: true, version: 1 } };
  });
  on('session.id', () => ({ value: SESSION_ID }));
  on('store.get', (_$, e) => ({ value: seen.store.get(e.key) }));
  on('store.set', (_$, e) => {
    seen.store.set(e.key, e.value);
    return { value: undefined };
  });
  on('session.attach', (_$, e) => ({ clientId: e.clientId }));
  on('prompt.submit', (_$, e) => ({ text: e.text }));
  return seen;
};
