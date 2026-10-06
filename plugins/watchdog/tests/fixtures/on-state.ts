// Stubs for the `$.state` sources of an L2 test: the keys `on` (spec §5.1) and `health` (§12.3), and the
// Desktop events. Use with `stubSession` of ./session, which stubs the session id and the `$.store`.
import { SESSION_ID } from './session';
import type { OnEvents } from '../../hooks/on';
import type { SessionStubs } from './session';
import type { SessionStartInput } from 'claude-code';

export type StateStubs = OnEvents<'state.get' | 'state.set'>;

export type OnStateStubs = SessionStubs & StateStubs & OnEvents<'session.attach' | 'prompt.submit'>;

export type OnStateSeen = {
  // Each `$.state` value written under `on`, oldest first.
  onWrites: unknown[];
  // Each `$.state` value written under `health`, oldest first.
  healthWrites: unknown[];
  // Each `$.state` value written under `log` (the dump's records, §13.4), oldest first.
  logWrites: unknown[];
  // Each `$.state` value written under `reviews` (the reviews that run and the stop map, §7.8), oldest first.
  reviewsWrites: unknown[];
};

// The `$.store` key of the on flag.
export const ON_STORE_KEY = `on:${SESSION_ID}`;

// The `store` option of `stubSession`: the `$.store` value of `on:<SESSION_ID>` at load.
export const storedOn = (flag: unknown): ReadonlyMap<string, unknown> => new Map([[ON_STORE_KEY, flag]]);

// §5.3: Desktop `session.start` matches `-p`.
export const DESKTOP_START: SessionStartInput = { cwd: '/repo', surface: null, isInteractive: false };

export const DESKTOP_ATTACH = { surface: 'desktop', clientId: 'desktop:default' } as const;

export const PROMPT = { text: 'fix the bug', wait: false, origin: { kind: 'composer' } } as const;

// `$.state` alone, for a test whose other fixture stubs the prompts. `state` and `health` are the `$.state`
// values of `on` and `health` at load (a reload); a read gets the last write.
export const stubState = (on: StateStubs, seed: { state?: unknown; health?: unknown } = {}): OnStateSeen => {
  const seen: OnStateSeen = { onWrites: [], healthWrites: [], logWrites: [], reviewsWrites: [] };
  const values: Readonly<Record<string, () => unknown>> = {
    on: () => seen.onWrites.at(-1) ?? seed.state,
    health: () => seen.healthWrites.at(-1) ?? seed.health,
  };
  const writes: Readonly<Record<string, unknown[]>> = {
    on: seen.onWrites,
    health: seen.healthWrites,
    log: seen.logWrites,
    reviews: seen.reviewsWrites,
  };
  on('state.get', (_$, e) => ({ value: { value: values[e.key]?.(), version: 0 } }));
  on('state.set', (_$, e) => {
    writes[e.key]?.push(e.value);
    return { value: { isSet: true, version: 1 } };
  });
  return seen;
};

export const stubOnState = (on: OnStateStubs, seed: { state?: unknown; health?: unknown } = {}): OnStateSeen => {
  const seen = stubState(on, seed);
  on('session.attach', (_$, e) => ({ clientId: e.clientId }));
  on('prompt.submit', (_$, e) => ({ text: e.text }));
  return seen;
};
