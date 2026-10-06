import { MIN_FENCE_LENGTH, ONE_LINE_MAX } from '../constants';

// §7.6: the field labels of an update. The base prompt (`prompts/system.md`) names the same three; the
// renderer writes no other field label.
export const ASK_INPUT = 'Ask input';
export const TOOL_RESULT = 'Tool result';
export const ELIDED = 'elided';

// omp `oneLine`: whitespace runs collapse, and a longer text ends in `…` at `max` chars.
export const oneLine = (text: string, max = ONE_LINE_MAX): string => {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// A block field that holds text; '' for any other value.
export const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

// §7.6: the elision marker of a cut text and of a collapsed update, with the count of the chars it stands for.
export const elisionMarker = (chars: number): string => `[… ${chars} chars ${ELIDED} …]`;

// §7.6: a text over `cap` keeps its head and its tail, with the marker between them.
export const elide = (text: string, cap: number): string => {
  if (text.length <= cap) {
    return text;
  }
  const head = Math.ceil(cap / 2);
  return `${text.slice(0, head)}${elisionMarker(text.length - cap)}${text.slice(text.length - (cap - head))}`;
};

// omp `fencedText`: a fence longer than every backtick run in the text.
export const fenced = (text: string, language: string): string => {
  const longest = Math.max(0, ...(text.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(MIN_FENCE_LENGTH, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
};

const blockText = (block: unknown): string => {
  if (typeof block !== 'object' || block === null) {
    return String(block);
  }
  if ('text' in block && typeof block.text === 'string') {
    return block.text;
  }
  return 'type' in block && typeof block.type === 'string' ? `[${block.type}]` : JSON.stringify(block);
};

// The text of a block list, a tool result's `content`, or any other value: text blocks joined, another
// block as `[type]`, a value with no text as JSON.
export const contentText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(blockText).join('\n');
  }
  return content === undefined ? '' : JSON.stringify(content);
};

// omp `toolCallLine` status: `ok · N lines`, or `error · N lines — <first line>`.
export const resultStatus = (text: string, isError: boolean): string => {
  const count = text === '' ? 0 : text.split('\n').length;
  const status = `${isError ? 'error' : 'ok'} · ${count} ${count === 1 ? 'line' : 'lines'}`;
  const firstLine = isError ? oneLine(text.split('\n', 1)[0] ?? '') : '';
  return firstLine === '' ? status : `${status} — ${firstLine}`;
};

// A tool call's input, as the model gave it.
export type ToolInput = { readonly [argument: string]: unknown; readonly pattern?: unknown; readonly path?: unknown };

export const isToolInput = (input: unknown): input is ToolInput =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

// omp `PRIMARY_ARG_KEYS`: the argument that says most about a call, first match wins.
const PRIMARY_ARG_KEYS = [
  'path',
  'file_path',
  'filePath',
  'command',
  'cmd',
  'pattern',
  'url',
  'query',
  'prompt',
  'assignment',
  'note',
  'message',
  'op',
  'name',
  'id',
] as const;

// omp `primaryArgValue`: a non-empty string, or a list of strings.
const argText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  const isList = Array.isArray(value) && value.every((entry) => typeof entry === 'string');
  return isList ? value.join(', ') : '';
};

// omp `grep`/`glob` rule for Claude Code's `Grep` and `Glob`: `pattern @ path`.
const searchArg = (name: string, input: ToolInput): string => {
  const pattern = argText(input.pattern);
  const path = argText(input.path);
  if ((name !== 'Grep' && name !== 'Glob') || pattern === '') {
    return '';
  }
  return path === '' ? pattern : `${pattern} @ ${path}`;
};

// omp `formatToolCallPrimaryArg`: the most telling argument on one line, else the first string argument,
// else the input as JSON (`{}` when it has none).
export const primaryArg = (name: string, input: unknown): string => {
  if (!isToolInput(input)) {
    return '';
  }
  const key = PRIMARY_ARG_KEYS.find((candidate) => argText(input[candidate]) !== '');
  const firstString = Object.values(input).find((value): value is string => typeof value === 'string' && value !== '');
  const text = [searchArg(name, input), key === undefined ? '' : argText(input[key]), firstString ?? ''].find(
    (part) => part !== ''
  );
  if (text !== undefined) {
    return oneLine(text);
  }
  return Object.keys(input).length === 0 ? '{}' : oneLine(JSON.stringify(input));
};
