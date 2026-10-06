import { DEFAULT_WATCHDOG } from '../agents/roster';
import type { Note } from '../note/notes';
import type { Severity } from '../note/tool';

// §10.7: one note as the wrapper writes it. `watchdog` is the name, undefined for the default watchdog;
// `subagent` the type of a late note on a subagent; `turnsAgo` is the `turn.start` counter now minus its value
// when the watchdog made the note.
export type WrappedNote = {
  readonly watchdog?: string;
  readonly severity: Severity;
  readonly subagent?: string;
  readonly turnsAgo: number;
  readonly text: string;
};

const XML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

// §10.7: XML-escapes a note text or an attribute value; §7.6: the text of a `<primary-context>` block.
export const escapeXml = (text: string): string => text.replaceAll(/[&<>"]/gu, (char) => XML_ESCAPES[char] ?? char);

const attribute = (name: string, value: string | undefined): string =>
  value === undefined ? '' : ` ${name}="${escapeXml(value)}"`;

const noteElement = (note: WrappedNote): string =>
  `<note${attribute('watchdog', note.watchdog)}${attribute('severity', note.severity)}${attribute(
    'subagent',
    note.subagent
  )}${attribute('turns_ago', note.turnsAgo > 0 ? String(note.turnsAgo) : undefined)}>${escapeXml(note.text)}</note>`;

// §10.7: the `<watchdog-notes>` block of every route; `guidance` is the shipped `prompts/boundary-guidance.md`.
export const wrapNotes = (guidance: string, notes: readonly WrappedNote[]): string =>
  ['<watchdog-notes>', guidance.trim(), ...notes.map(noteElement), '</watchdog-notes>'].join('\n');

// §10.7: a held note as the wrapper writes it: no name for the default watchdog, the type of a note on a
// subagent, its age in main turns.
export const wrappedNote = (note: Note, name: string, turn: number): WrappedNote => ({
  ...(note.watchdog === DEFAULT_WATCHDOG.slug ? {} : { watchdog: name }),
  severity: note.severity,
  ...(note.subagent === undefined ? {} : { subagent: note.subagent.type }),
  turnsAgo: turn - note.turn,
  text: note.text,
});
