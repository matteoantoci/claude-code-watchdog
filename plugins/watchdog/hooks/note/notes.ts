import { normalizeNote } from './guard';
import type { Severity } from './tool';
import type { PluginState } from 'claude-code';

// Build-session choice "Delivery state labels": one list for the card header, the log row, the recap
// and the dump.
const DELIVERY_STATES = ['steered', 'aside on next prompt', 'nudged', 'held', 'displaced', 'discarded'] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number] | `dropped:${string}`;

export const isDeliveryState = (value: unknown): value is DeliveryState =>
  typeof value === 'string' && (DELIVERY_STATES.some((state) => state === value) || value.startsWith('dropped:'));

// §11.3: the watched subagent that a note is about (`WatchdogSubagentRef` of the state contract).
export type SubagentRef = NonNullable<PluginState['watchdog']['nudge']['notes'][number]['subagent']>;

// One note a watchdog sent; `watchdog` is its slug, `turn` the main-loop turn counter when it came (§10.7).
// §11.3: `subagent` is the watched subagent of a review of a subagent.
export type Note = {
  readonly watchdog: string;
  readonly agentId: string;
  readonly severity: Severity;
  readonly text: string;
  readonly turn: number;
  readonly subagent?: SubagentRef;
};

export type HeldNote = Note & { readonly delivery: DeliveryState };

// Another area's guard drops a note after the destructive check (§12.6) and before the emission guard (§9):
// it returns the ack the watchdog reads, or undefined.
export type NoteGuard = (note: Note) => string | undefined;

// A delivery route claims an admitted note (§10, §11.3): it returns its delivery state, or undefined.
export type DeliveryRoute = (note: Note) => DeliveryState | undefined;

// §11.3: a binding marks a held note that waits for a subagent's own tool result; the primary agent's
// deliveries neither take nor reroute it.
export type NoteBinding = (note: HeldNote) => boolean;

const guards: NoteGuard[] = [];
const routes: DeliveryRoute[] = [];
const bindings: NoteBinding[] = [];
const held: HeldNote[] = [];

// §13.1: a watcher sees each note that the held list gets (`before` undefined) or changes in place (a raise,
// a new route); a note that leaves the list (taken for delivery, displaced) reaches no watcher.
export type HeldNoteWatcher = (before: HeldNote | undefined, after: HeldNote) => void;

const watchers: HeldNoteWatcher[] = [];

export const watchHeldNotes = (watcher: HeldNoteWatcher): void => {
  watchers.push(watcher);
};

const tell = (before: HeldNote | undefined, after: HeldNote): void => {
  watchers.forEach((watcher) => {
    watcher(before, after);
  });
};

// Guards, routes and bindings run in the order the areas add them, in their `installX(on)`.
export const addNoteGuard = (guard: NoteGuard): void => {
  guards.push(guard);
};

export const addDeliveryRoute = (route: DeliveryRoute): void => {
  routes.push(route);
};

export const addNoteBinding = (binding: NoteBinding): void => {
  bindings.push(binding);
};

const isBound = (note: HeldNote): boolean => bindings.some((binding) => binding(note));

// The first guard that drops the note gives its ack.
export const guardNote = (note: Note): string | undefined =>
  guards.reduce<string | undefined>((ack, guard) => ack ?? guard(note), undefined);

// The first route that claims the note gives its state; a note no route claims is `held`.
export const deliveryFor = (note: Note): DeliveryState =>
  routes.reduce<DeliveryState | undefined>((state, route) => state ?? route(note), undefined) ?? 'held';

// Admitted notes that wait for their delivery, oldest first.
export const holdNote = (note: HeldNote): void => {
  held.push(note);
  tell(undefined, note);
};

// §9.1, §11.4: the queued entry of a watchdog for one normalized text on one watched agent, while it waits
// for delivery.
export const heldNoteOf = (note: Pick<Note, 'watchdog' | 'subagent'>, key: string): HeldNote | undefined =>
  held.find(
    (queued) =>
      queued.watchdog === note.watchdog &&
      queued.subagent?.agentId === note.subagent?.agentId &&
      normalizeNote(queued.text) === key
  );

// §9.1: a raise replaces the queued entry in place; §9.4: a displaced note leaves with no replacement.
export const replaceHeldNote = (note: HeldNote, replacement?: HeldNote): void => {
  const at = held.indexOf(note);
  if (at !== -1) {
    held.splice(at, 1, ...(replacement === undefined ? [] : [replacement]));
  }
  if (at !== -1 && replacement !== undefined) {
    tell(note, replacement);
  }
};

const take = (isTaken: (note: HeldNote) => boolean): HeldNote[] => {
  const taken = held.filter(isTaken);
  held.splice(0, held.length, ...held.filter((note) => !isTaken(note)));
  return taken;
};

// A delivery to the primary agent takes the held notes in the given states out of the list, oldest first.
export const takeNotes = (...deliveries: readonly DeliveryState[]): HeldNote[] =>
  take((note) => deliveries.includes(note.delivery) && !isBound(note));

// §11.3: a steer into a subagent takes the bound notes on it, oldest first.
export const takeBoundNotes = (agentId: string): HeldNote[] =>
  take((note) => note.subagent?.agentId === agentId && isBound(note));

// The held notes, oldest first, as they wait now.
export const heldNotes = (): readonly HeldNote[] => held;

// §10.3: a late note changes its route in place (a steer with no tool result before the turn ended, a nudge
// whose wait a new turn ended).
export const rerouteNotes = (route: (note: HeldNote) => DeliveryState): void => {
  held.forEach((note, index) => {
    const delivery = isBound(note) ? note.delivery : route(note);
    if (delivery !== note.delivery) {
      const rerouted = { ...note, delivery };
      held[index] = rerouted;
      tell(note, rerouted);
    }
  });
};

// §5.2: `/watchdog off` clears the held notes.
export const clearHeldNotes = (): void => {
  held.length = 0;
};

// §13.2, §11.3: the `$.ui.log` row of one note; a note on a subagent shows its type beside the severity.
export const logRow = (note: HeldNote, name: string): string =>
  `[${[note.severity, ...(note.subagent === undefined ? [] : [note.subagent.type])].join(' · ')}] ${name}: ${note.text} (${note.delivery})`;
