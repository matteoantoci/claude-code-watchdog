import { normalizeNote } from './guard';
import type { Severity } from './tool';

// Build-session choice "Delivery state labels": one list for the card header, the log row, the recap
// and the dump.
const DELIVERY_STATES = ['steered', 'aside on next prompt', 'nudged', 'held', 'displaced', 'discarded'] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number] | `dropped:${string}`;

export const isDeliveryState = (value: unknown): value is DeliveryState =>
  typeof value === 'string' && (DELIVERY_STATES.some((state) => state === value) || value.startsWith('dropped:'));

// One note a watchdog sent; `watchdog` is its slug, `turn` the main-loop turn counter when it came (§10.7).
export type Note = {
  readonly watchdog: string;
  readonly agentId: string;
  readonly severity: Severity;
  readonly text: string;
  readonly turn: number;
};

export type HeldNote = Note & { readonly delivery: DeliveryState };

// Another area's guard drops a note after the destructive check (§12.6) and before the emission guard (§9):
// it returns the ack the watchdog reads, or undefined.
export type NoteGuard = (note: Note) => string | undefined;

// A delivery route claims an admitted note (§10, §11.3): it returns its delivery state, or undefined.
export type DeliveryRoute = (note: Note) => DeliveryState | undefined;

const guards: NoteGuard[] = [];
const routes: DeliveryRoute[] = [];
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

// Guards and routes run in the order the areas add them, in their `installX(on)`.
export const addNoteGuard = (guard: NoteGuard): void => {
  guards.push(guard);
};

export const addDeliveryRoute = (route: DeliveryRoute): void => {
  routes.push(route);
};

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

// §9.1: the queued entry of a watchdog for one normalized text, while it waits for delivery.
export const heldNoteOf = (watchdog: string, key: string): HeldNote | undefined =>
  held.find((note) => note.watchdog === watchdog && normalizeNote(note.text) === key);

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

// A delivery takes the held notes in the given states out of the list, oldest first.
export const takeNotes = (...deliveries: readonly DeliveryState[]): HeldNote[] => {
  const taken = held.filter((note) => deliveries.includes(note.delivery));
  const kept = held.filter((note) => !deliveries.includes(note.delivery));
  held.splice(0, held.length, ...kept);
  return taken;
};

// The held notes, oldest first, as they wait now.
export const heldNotes = (): readonly HeldNote[] => held;

// §10.3: a late note changes its route in place (a steer with no tool result before the turn ended, a nudge
// whose wait a new turn ended).
export const rerouteNotes = (route: (note: HeldNote) => DeliveryState): void => {
  held.forEach((note, index) => {
    const delivery = route(note);
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

// §13.2: the `$.ui.log` row of one note.
export const logRow = (note: HeldNote, name: string): string =>
  `[${note.severity}] ${name}: ${note.text} (${note.delivery})`;
