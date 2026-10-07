import { THINKING_CAP, TOOL_INPUT_CAP, TOOL_RESULT_CAP } from '../constants';
import { escapeXml } from '../delivery/wrapper';
import { isPersonPrompt } from '../person';
import {
  ASK_INPUT,
  TOOL_RESULT,
  contentText,
  elide,
  fenced,
  isToolInput,
  oneLine,
  primaryArg,
  resultStatus,
  textOf,
} from './text';
import type { ApiContentBlock, PluginState, SessionAppendInput, TurnStepServerToolUse } from 'claude-code';

// §7.6: one rendered piece of a row; the feed gives it a uuid.
export type Piece = Omit<PluginState['watchdog']['feed']['rows'][number], 'uuid'>;

// The result of one tool call: the status for its call line and the `Tool result` section under it.
export type Settlement = {
  readonly id: string;
  readonly tool: string;
  readonly status: string;
  readonly section: string;
};

export type RenderedRow = {
  readonly pieces: readonly Piece[];
  readonly settlements: readonly Settlement[];
  // §7.7 part 2: the row is a person prompt.
  readonly isPersonPrompt: boolean;
};

// omp `ask` is Claude Code's `AskUserQuestion`: its input shows under `Ask input`, and its result holds the
// person's answers, which are never cut (§7.6).
const ASK_TOOL = 'AskUserQuestion';

const PENDING = ' ⇒ pending';

// §7.6: the full tool input on the call line, at most 8,000 chars: a lone one-line string bare (omp's
// `→ Read(path)`), else compact JSON.
const inputText = (input: unknown): string => {
  const values = isToolInput(input) ? Object.values(input) : [];
  const [only] = values;
  const isBare = values.length === 1 && typeof only === 'string' && !only.includes('\n');
  return elide(isBare ? only : JSON.stringify(input ?? {}), TOOL_INPUT_CAP);
};

// §10.8: the calls that write a file, whose path the outdated mark of a note counts.
const EDIT_TOOLS: Readonly<Record<string, true>> = { Edit: true, Write: true, MultiEdit: true, NotebookEdit: true };

// §10.8: the file an edit call writes; none for another call.
const editOf = (name: string, input: unknown): { readonly edit?: string } => {
  const isEdit = Object.hasOwn(EDIT_TOOLS, name) && isToolInput(input);
  const path = isEdit ? textOf(input.file_path) || textOf(input.notebook_path) : '';
  return path === '' ? {} : { edit: path };
};

// omp `toolCallLine` before its result: `→ name(args) ⇒ pending`; the brief keeps omp's one-line argument.
const callPiece = (block: ApiContentBlock): Piece => {
  const name = textOf(block.name);
  const brief = `→ ${name}(${primaryArg(name, block.input)})${PENDING}`;
  const call = textOf(block.id);
  if (name !== ASK_TOOL) {
    const text = `→ ${name}(${inputText(block.input)})${PENDING}`;
    return { text, role: 'agent', brief, call, ...editOf(name, block.input) };
  }
  const ask = fenced(elide(JSON.stringify(block.input ?? {}, null, 2), TOOL_INPUT_CAP), 'json');
  return { text: `${brief}\n${ASK_INPUT}:\n${ask}`, role: 'agent', brief, call };
};

const thinkingPiece = (block: ApiContentBlock): Piece | undefined => {
  const thinking = textOf(block.thinking);
  return thinking.trim() === '' ? undefined : { text: `_thinking:_ ${elide(thinking, THINKING_CAP)}`, role: 'agent' };
};

// §7.6: a server tool call is one line, and its result is one line.
const serverCallPiece = (block: ApiContentBlock): Piece => {
  const line = `→ ${textOf(block.name)}(${primaryArg(textOf(block.name), block.input)})`;
  return { text: line, role: 'agent', brief: line, call: textOf(block.id) };
};

const otherBlockPiece = (block: ApiContentBlock): Piece => {
  const isServerResult = block.type.endsWith('_tool_result') && typeof block.tool_use_id === 'string';
  const text = isServerResult ? `⇒ ${block.type}: ${oneLine(contentText(block.content))}` : `[${block.type}]`;
  return { text, role: 'agent' };
};

// omp `formatSessionHistoryMarkdown`, assistant blocks: text, `_thinking:_` only with text, tool lines.
// §7.6: `[thinking redacted]` only for a real `redacted_thinking` block.
const RESPONSE_BLOCKS: Readonly<Record<string, (block: ApiContentBlock) => Piece | undefined>> = {
  text: (block) => (textOf(block.text).trim() === '' ? undefined : { text: textOf(block.text), role: 'agent' }),
  thinking: thinkingPiece,
  redacted_thinking: () => ({ text: '[thinking redacted]', role: 'agent' }),
  tool_use: callPiece,
  server_tool_use: serverCallPiece,
};

const responsePieces = (blocks: readonly ApiContentBlock[]): Piece[] =>
  blocks.flatMap((block) => (RESPONSE_BLOCKS[block.type] ?? otherBlockPiece)(block) ?? []);

const settlementOf = (block: ApiContentBlock, tool: string): Settlement => {
  const text = contentText(block.content);
  const shown = tool === ASK_TOOL ? text : elide(text, TOOL_RESULT_CAP);
  return {
    id: textOf(block.tool_use_id),
    tool,
    status: resultStatus(text, block.is_error === true),
    section: text.trim() === '' ? '' : `${TOOL_RESULT}:\n${fenced(shown, 'text')}`,
  };
};

// §7.6: a row from another plugin, an attachment, hook context, a notice or any prompt that is not a person
// prompt is one line, tagged with where it came from.
const lineLabel = (row: SessionAppendInput): string => {
  const { origin } = row;
  if (origin.kind === 'plugin') {
    return `plugin ${'name' in origin ? origin.name : origin.event}`;
  }
  if (origin.kind === 'hook') {
    return `hook ${origin.event}`;
  }
  if (row.door === 'prompt') {
    return origin.kind;
  }
  return row.message.name === undefined ? row.door : `${row.door} ${row.message.name}`;
};

const linePiece = (row: SessionAppendInput, blocks: readonly ApiContentBlock[]): Piece => ({
  text: `[${lineLabel(row)}] ${oneLine(contentText(blocks))}`.trimEnd(),
});

const toolResultRow = (row: SessionAppendInput): RenderedRow => {
  const tool = row.origin.kind === 'tool' ? row.origin.tool : 'unknown';
  const results = row.message.content.filter((block) => block.type === 'tool_result');
  const rest = row.message.content.filter((block) => block.type !== 'tool_result');
  return {
    pieces: rest.length === 0 ? [] : [linePiece(row, rest)],
    settlements: results.map((block) => settlementOf(block, tool)),
    isPersonPrompt: false,
  };
};

// §7.6: text that the person typed, in full. [INFERENCE] A `delivery` row is a prompt delivered into a
// running turn, the person's included, so it shows in full too.
const isPersonRow = (row: SessionAppendInput): boolean =>
  (isPersonPrompt(row.origin) && row.message.isMeta !== true && row.door !== 'command') || row.door === 'delivery';

const userRow = (row: SessionAppendInput): RenderedRow => {
  const text = contentText(row.message.content);
  return {
    pieces: text.trim() === '' ? [] : [{ text, role: 'user', brief: text }],
    settlements: [],
    isPersonPrompt: row.door === 'prompt',
  };
};

// §7.6: the compaction summary, XML-escaped, as omp writes its primary-context blocks.
const compactionPiece = (row: SessionAppendInput): Piece[] => {
  const summary = contentText(row.message.content).trim();
  return summary === ''
    ? []
    : [{ text: `<primary-context kind="compaction">\n${escapeXml(summary)}\n</primary-context>` }];
};

const only = (pieces: readonly Piece[]): RenderedRow => ({ pieces, settlements: [], isPersonPrompt: false });

// §7.6: one `session.append` row of the primary agent in the omp markdown form, with the caps applied. A
// tool result settles its call (`settleCall`).
export const renderRow = (row: SessionAppendInput): RenderedRow => {
  if (row.door === 'response') {
    return only(responsePieces(row.message.content));
  }
  if (row.door === 'tool-result') {
    return toolResultRow(row);
  }
  if (row.door === 'compaction') {
    return only(compactionPiece(row));
  }
  return isPersonRow(row) ? userRow(row) : only([linePiece(row, row.message.content)]);
};

// A pending call takes its result: the status on the call line and on the brief, the result under it.
export const isPending = (piece: Piece): boolean => piece.brief?.endsWith(PENDING) === true;

const settleLine = (text: string, status: string): string => {
  const end = text.includes('\n') ? text.indexOf('\n') : text.length;
  return `${text.slice(0, end - PENDING.length)} ⇒ ${status}${text.slice(end)}`;
};

export const settleCall = (piece: Piece, settlement: Settlement): { text: string; brief: string } => ({
  text: `${settleLine(piece.text, settlement.status)}${settlement.section === '' ? '' : `\n${settlement.section}`}`,
  brief: settleLine(piece.brief ?? '', settlement.status),
});

// omp's orphan result line (`toolCallLine` with no arguments), for a result whose call the feed lacks.
export const orphanPiece = (settlement: Settlement): Piece => {
  const line = `→ ${settlement.tool}()${PENDING}`;
  return { ...settleCall({ text: line, brief: line }, settlement), call: settlement.id };
};

// §7.6: a server tool call that only `turn.step` names: its call line and its result line.
export const serverToolPiece = (use: TurnStepServerToolUse): Piece => {
  const line = `→ ${use.name}(${primaryArg(use.name, use.input)})`;
  const result = use.endedAt === undefined ? 'no result' : 'done';
  return { text: `${line}\n⇒ ${use.name}: ${result}`, role: 'agent', brief: line, call: use.id };
};
