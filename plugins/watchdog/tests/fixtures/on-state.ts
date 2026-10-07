// Stubs for the `$.state` sources of an L2 test: the keys `on` (spec §5.1), `health` (§12.3) and `band`
// (§13.1), and the Desktop events. Use with `stubSession` of ./session, which stubs the session id and the
// `$.store`.
import { COMPOSER_SUBMIT } from './engine/composer-prompt';
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
  // Each `$.state` value written under `band` (the band cards, §13.1), oldest first.
  bandWrites: unknown[];
  // §14: each session id's `$.state`: each value written under every key, oldest first; a family member under
  // `<key>:<id>`.
  sessions: Map<string, Map<string, unknown[]>>;
};

// The `$.state` values of `on`, `health` and `band` at load (a reload); `values` holds any other key's, a family
// member's under `<key>:<id>`. The seed is the `$.state` of `SESSION_ID`; `sessionId` names the session now, as
// `stubSession` gets it (default `SESSION_ID`): `$.state` lasts one session id.
export type StateSeed = {
  state?: unknown;
  health?: unknown;
  band?: unknown;
  values?: ReadonlyMap<string, unknown>;
  sessionId?: () => string;
  // The reason each `$.state.set` denies with; nothing is written then (§14.2).
  setDeny?: string;
};

// A key's name in the stub: a family member's is `<key>:<id>`.
const nameOf = (e: { key: string; id?: string }): string => (e.id === undefined ? e.key : `${e.key}:${e.id}`);

// The last value written under `key` in one session's `$.state`.
export const stateIn = (seen: OnStateSeen, sessionId: string, key: string): unknown =>
  seen.sessions.get(sessionId)?.get(key)?.at(-1);

// The `$.store` key of the on flag.
export const ON_STORE_KEY = `on:${SESSION_ID}`;

// The `store` option of `stubSession`: the `$.store` value of `on:<SESSION_ID>` at load.
export const storedOn = (flag: unknown): ReadonlyMap<string, unknown> => new Map([[ON_STORE_KEY, flag]]);

// §5.3: Desktop `session.start` matches `-p`.
export const DESKTOP_START: SessionStartInput = { cwd: '/repo', surface: null, isInteractive: false };

export const DESKTOP_ATTACH = { surface: 'desktop', clientId: 'desktop:default' } as const;

// A typed prompt in the recorded shape.
export const PROMPT = { ...COMPOSER_SUBMIT, text: 'fix the bug' };

// `$.state` alone, for a test whose other fixture stubs the prompts. A read gets the last write of its key in
// the session now, else the seed.
export const stubState = (on: StateStubs, seed: StateSeed = {}): OnStateSeen => {
  const seen: OnStateSeen = {
    onWrites: [],
    healthWrites: [],
    logWrites: [],
    reviewsWrites: [],
    bandWrites: [],
    sessions: new Map(),
  };
  const seeds = new Map<string, unknown>([
    ...(seed.values ?? []),
    ['on', seed.state],
    ['health', seed.health],
    ['band', seed.band],
  ]);
  const writes: Readonly<Record<string, unknown[]>> = {
    on: seen.onWrites,
    health: seen.healthWrites,
    log: seen.logWrites,
    reviews: seen.reviewsWrites,
    band: seen.bandWrites,
  };
  // §14: `$.state` is empty after each session change, a `/resume` to an earlier id too; the seed is the first
  // session's.
  const current = seed.sessionId ?? (() => SESSION_ID);
  const live = { id: current(), isSeeded: true, values: new Map<string, unknown[]>() };
  const session = (): Map<string, unknown[]> => {
    if (live.id !== current()) {
      Object.assign(live, { id: current(), isSeeded: false, values: new Map<string, unknown[]>() });
    }
    seen.sessions.set(live.id, live.values);
    return live.values;
  };
  const read = (key: string): unknown => session().get(key)?.at(-1) ?? (live.isSeeded ? seeds.get(key) : undefined);
  on('state.get', (_$, e) => ({ value: { value: read(nameOf(e)), version: 0 } }));
  on('state.set', (_$, e) => {
    if (seed.setDeny !== undefined) {
      return { deny: seed.setDeny };
    }
    writes[e.key]?.push(e.value);
    session().set(nameOf(e), [...(session().get(nameOf(e)) ?? []), e.value]);
    return { value: { isSet: true, version: 1 } };
  });
  return seen;
};

export const stubOnState = (on: OnStateStubs, seed: StateSeed = {}): OnStateSeen => {
  const seen = stubState(on, seed);
  on('session.attach', (_$, e) => ({ clientId: e.clientId }));
  on('prompt.submit', (_$, e) => ({ text: e.text }));
  return seen;
};
