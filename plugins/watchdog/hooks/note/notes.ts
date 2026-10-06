import type { Severity } from './tool';

// Build-session choice "Delivery state labels": one list for the card header, the log row, the recap
// and the dump.
export type DeliveryState =
  | 'steered'
  | 'aside on next prompt'
  | 'nudged'
  | 'held'
  | 'displaced'
  | 'discarded'
  | `dropped:${string}`;

// One note a watchdog sent; `watchdog` is its slug.
export type Note = {
  readonly watchdog: string;
  readonly agentId: string;
  readonly severity: Severity;
  readonly text: string;
};

export type HeldNote = Note & { readonly delivery: DeliveryState };

// A guard drops a note before admission (§9, §12.6): it returns the ack the watchdog reads, or undefined.
export type NoteGuard = (note: Note) => string | undefined;

// A delivery route claims an admitted note (§10, §11.3): it returns its delivery state, or undefined.
export type DeliveryRoute = (note: Note) => DeliveryState | undefined;

const guards: NoteGuard[] = [];
const routes: DeliveryRoute[] = [];
const held: HeldNote[] = [];

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
};

// §5.2: `/watchdog off` clears the held notes.
export const clearHeldNotes = (): void => {
  held.length = 0;
};

// §13.2: the `$.ui.log` row of one note.
export const logRow = (note: HeldNote, name: string): string =>
  `[${note.severity}] ${name}: ${note.text} (${note.delivery})`;
