import { DEFAULT_WATCHDOG } from '../agents/roster';
import { MAX_NOTES_PER_REVIEW, SLUG_MAX_LENGTH } from '../constants';
import { errorText } from '../errors';
import { isEffortSetting, parseModel } from './model';
import { checkTools } from './tools';
import type { ReviewMode, Watchdog } from '../agents/roster';
import type { EffortSetting } from './model';
import type { JsonValue } from 'claude-code';

// One `WATCHDOG.json` as read: `label` names it in the status and the warnings (§13.3).
export type RosterText = { readonly label: string; readonly isUser: boolean; readonly text: string };

// §4.2: an entry before the merge; its `maxNotesPerReview` falls back to the merged top-level value.
export type ParsedEntry = Omit<Watchdog, 'maxNotesPerReview'> & { readonly maxNotesPerReview: number | undefined };

// §11.1: `false` removes the key of an earlier file (§4.2).
export type SubagentChoice = boolean | readonly string[];

// §4.2: what one file sets. `watchdogs` is undefined when the file has no valid `watchdogs` key.
export type ParsedFile = {
  readonly instructions: string | undefined;
  readonly maxNotesPerReview: number | undefined;
  readonly watchdogs: readonly ParsedEntry[] | undefined;
  readonly subagents: Readonly<Record<string, SubagentChoice>>;
  readonly warnings: readonly string[];
};

// A JSON object as `JSON.parse` gives it.
type Doc = Readonly<Record<string, JsonValue>>;

const isObject = (value: unknown): value is Doc => typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(isString);

const isReviewMode = (value: unknown): value is ReviewMode => value === 'turn' || value === 'agent-end';

const isInterval = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

const isNotesCap = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_NOTES_PER_REVIEW;

const NOTES_CAP_TYPE = `an integer from 1 to ${MAX_NOTES_PER_REVIEW}`;

const isSubagentChoice = (value: unknown): value is SubagentChoice => isBoolean(value) || isStringList(value);

// A key of the file and the type its value must have.
type KeyType = { readonly type: string; readonly isValid: (value: unknown) => boolean };

// §4.2: the keys of an entry; a wrong type drops the whole entry (§4.6).
const ENTRY_KEYS: Readonly<Record<string, KeyType>> = {
  name: { type: 'a string', isValid: isString },
  enabled: { type: 'true or false', isValid: isBoolean },
  model: { type: 'a string', isValid: isString },
  effort: { type: 'one of low, medium, high, xhigh, max, auto', isValid: isEffortSetting },
  tools: { type: 'a list of strings', isValid: isStringList },
  reviewMode: { type: '"turn" or "agent-end"', isValid: isReviewMode },
  reviewInterval: { type: 'an integer of 1 or more', isValid: isInterval },
  maxNotesPerReview: { type: NOTES_CAP_TYPE, isValid: isNotesCap },
  instructions: { type: 'a string', isValid: isString },
};

// §4.2: the top-level keys; a wrong type drops only that key (§4.6).
const TOP_KEYS: Readonly<Record<string, KeyType>> = {
  instructions: { type: 'a string', isValid: isString },
  maxNotesPerReview: { type: NOTES_CAP_TYPE, isValid: isNotesCap },
  watchdogs: { type: 'a list of entries', isValid: Array.isArray },
  subagents: { type: 'an object', isValid: isObject },
};

// §4.6: the unknown keys of `doc`, and each known key whose value has the wrong type, in file order.
const checkKeys = (doc: Doc, keys: Readonly<Record<string, KeyType>>): { unknown: string[]; wrong: string[] } => {
  const typeOf = (key: string): KeyType | undefined => (Object.hasOwn(keys, key) ? keys[key] : undefined);
  return {
    unknown: Object.keys(doc).filter((key) => typeOf(key) === undefined),
    wrong: Object.entries(doc).flatMap(([key, value]) => {
      const type = typeOf(key);
      return type === undefined || type.isValid(value) ? [] : [`"${key}" must be ${type.type}`];
    }),
  };
};

// The value of a key when it has the type, else undefined.
const field = <T>(doc: Doc, key: string, isValid: (value: unknown) => value is T): T | undefined => {
  const value = doc[key];
  return isValid(value) ? value : undefined;
};

// §4.2: lowercase, each run of other characters one `-`, at most 64 characters. Like omp, no `-` at either end.
const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/u, '');

// §6.2: `inherit` gives a warning and the default model; another provider keeps the entry as `no_model`.
const modelOf = (
  text: string
): { model: string; level: EffortSetting | undefined; noModel: string | null; problems: string[] } => {
  const setting = parseModel(text);
  if (setting.kind === 'inherit') {
    const problems = [`model "${text}" dropped; the default model applies`];
    return { model: DEFAULT_WATCHDOG.model, level: undefined, noModel: null, problems };
  }
  return setting.kind === 'model'
    ? { model: setting.model, level: setting.level, noModel: null, problems: [] }
    : { model: text, level: undefined, noModel: setting.reason, problems: [] };
};

// An entry whose keys all have their type: the defaults fill the absent keys (§4.2).
const buildEntry = (doc: Doc, name: string, file: RosterText): { entry: ParsedEntry; problems: string[] } => {
  const model = modelOf(field(doc, 'model', isString) ?? DEFAULT_WATCHDOG.model);
  const tools = checkTools(field(doc, 'tools', isStringList) ?? DEFAULT_WATCHDOG.tools, file.isUser);
  const entry: ParsedEntry = {
    name,
    slug: slugOf(name),
    isEnabled: field(doc, 'enabled', isBoolean) ?? DEFAULT_WATCHDOG.isEnabled,
    model: model.model,
    effort: field(doc, 'effort', isEffortSetting) ?? model.level ?? DEFAULT_WATCHDOG.effort,
    noModel: model.noModel,
    tools: tools.tools,
    reviewMode: field(doc, 'reviewMode', isReviewMode) ?? DEFAULT_WATCHDOG.reviewMode,
    reviewInterval: field(doc, 'reviewInterval', isInterval) ?? DEFAULT_WATCHDOG.reviewInterval,
    maxNotesPerReview: field(doc, 'maxNotesPerReview', isNotesCap),
    instructions: field(doc, 'instructions', isString) ?? null,
    source: file.label,
  };
  return { entry, problems: [...model.problems, ...tools.problems] };
};

type EntryResult = { readonly entry?: ParsedEntry; readonly warnings: readonly string[] };

// §4.6: why an entry is dropped: a wrong type, no name, or a name that makes no slug.
const dropReason = (wrong: readonly string[], name: string | undefined): string | undefined => {
  if (wrong.length > 0) {
    return wrong.join(', ');
  }
  if (name === undefined) {
    return '"name" is required';
  }
  return slugOf(name) === '' ? `name "${name}" makes an empty slug` : undefined;
};

// §4.6: an unknown key drops only that key; a wrong type, no name or a name with no slug drops the entry.
// Each warning names the file and the entry.
const parseEntry = (raw: unknown, index: number, file: RosterText): EntryResult => {
  const name = isObject(raw) ? field(raw, 'name', isString) : undefined;
  const at = `${file.label}: ${name === undefined ? `watchdog #${index + 1}` : `watchdog "${name}"`}: `;
  if (!isObject(raw)) {
    return { warnings: [`${at}must be an object; watchdog dropped`] };
  }
  const { unknown, wrong } = checkKeys(raw, ENTRY_KEYS);
  const unknownWarnings = unknown.map((key) => `${at}unknown key "${key}" dropped`);
  const dropped = dropReason(wrong, name);
  if (dropped !== undefined || name === undefined) {
    return { warnings: [...unknownWarnings, `${at}${dropped ?? '"name" is required'}; watchdog dropped`] };
  }
  const { entry, problems } = buildEntry(raw, name, file);
  return { entry, warnings: [...unknownWarnings, ...problems.map((problem) => `${at}${problem}`)] };
};

// §4.2, §4.6: the entries of one file. A later entry with the same slug replaces the earlier one at the
// merge; here it gives a warning.
const parseWatchdogs = (list: readonly unknown[], file: RosterText): { entries: ParsedEntry[]; warnings: string[] } => {
  const results = list.map((raw, index) => parseEntry(raw, index, file));
  const entries = results.flatMap((result) => (result.entry === undefined ? [] : [result.entry]));
  const duplicates = entries
    .filter((entry, index) => entries.slice(0, index).some((earlier) => earlier.slug === entry.slug))
    .map((entry) => `${file.label}: watchdog "${entry.name}": duplicate name in this file; the later entry wins`);
  return { entries, warnings: [...results.flatMap((result) => result.warnings), ...duplicates] };
};

// §4.2, §11.1: `true`, `false` or a list of watchdog slugs for each subagent type; another value drops its key.
const parseSubagents = (doc: Doc, label: string): { subagents: Record<string, SubagentChoice>; warnings: string[] } => {
  const entries = Object.entries(doc);
  return {
    subagents: Object.fromEntries(
      entries.flatMap(([key, value]) => (isSubagentChoice(value) ? [[key, value] as const] : []))
    ),
    warnings: entries
      .filter(([, value]) => !isSubagentChoice(value))
      .map(([key]) => `${label}: subagents "${key}" must be true, false or a list of watchdog slugs; key dropped`),
  };
};

const parseDoc = (doc: Doc, file: RosterText): ParsedFile => {
  const { unknown, wrong } = checkKeys(doc, TOP_KEYS);
  const watchdogs = Array.isArray(doc.watchdogs) ? parseWatchdogs(doc.watchdogs, file) : undefined;
  const subagents = isObject(doc.subagents) ? parseSubagents(doc.subagents, file.label) : undefined;
  return {
    instructions: field(doc, 'instructions', isString),
    maxNotesPerReview: field(doc, 'maxNotesPerReview', isNotesCap),
    watchdogs: watchdogs?.entries,
    subagents: subagents?.subagents ?? {},
    warnings: [
      ...unknown.map((key) => `${file.label}: unknown key "${key}" dropped`),
      ...wrong.map((problem) => `${file.label}: ${problem}; key dropped`),
      ...(watchdogs?.warnings ?? []),
      ...(subagents?.warnings ?? []),
    ],
  };
};

const parseJson = (text: string): { doc: unknown } | { error: string } => {
  try {
    return { doc: JSON.parse(text) };
  } catch (error) {
    return { error: errorText(error) };
  }
};

// A file the merge skips, with the warning that says why.
export const skippedFile = (warning: string): ParsedFile => ({
  instructions: undefined,
  maxNotesPerReview: undefined,
  watchdogs: undefined,
  subagents: {},
  warnings: [warning],
});

// §4.2, §4.6: one file. A file that does not parse is skipped with a warning.
export const parseRosterFile = (file: RosterText): ParsedFile => {
  const parsed = parseJson(file.text);
  if ('error' in parsed) {
    return skippedFile(`${file.label}: not valid JSON; file skipped (${parsed.error})`);
  }
  return isObject(parsed.doc)
    ? parseDoc(parsed.doc, file)
    : skippedFile(`${file.label}: not a JSON object; file skipped`);
};
