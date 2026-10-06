import { ALLOW_SET_CAP } from '../constants';
import { normalizePath } from './paths';
import type { PluginState } from 'claude-code';

// §6.5, §14.1: the match keys of the reads the primary agent and its subagents made, oldest first, and the
// read-scope denies of each watchdog slug.
export type AllowSet = PluginState['watchdog']['allow'];
export type DenyCounts = PluginState['watchdog']['denies'];

// A tool's arguments, with the keys the read scope reads.
type Arguments = {
  readonly file_path?: unknown;
  readonly path?: unknown;
  readonly pattern?: unknown;
  readonly [argument: string]: unknown;
};

// §6.5 item 1: the mod's own spawn, sends and stop (§7.8) keep the engine verdict.
const EXEMPT_TOOLS: Readonly<Record<string, true>> = { Agent: true, SendMessage: true, TaskStop: true };

// The keys `tool.call` carries beside the tool's own arguments (d.ts `ToolCallReserved`, `AgentLoop`,
// the built-in envelope); `tool.check` gives the arguments alone as `input`.
const ENVELOPE_KEYS: Readonly<Record<string, true>> = {
  tool: true,
  tool_use_id: true,
  agentId: true,
  consent: true,
  timeoutMs: true,
};

const isArguments = (input: unknown): input is Arguments =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

export const toolArguments = (call: Arguments): Arguments =>
  Object.fromEntries(Object.entries(call).filter(([key]) => ENVELOPE_KEYS[key] !== true));

// Grep and Glob: every key in key order, with `path` normalized; undefined when the path leaves `/`.
const searchKey = (tool: string, input: Arguments): string | undefined => {
  const path = typeof input.path === 'string' ? normalizePath(input.path) : input.path;
  if (typeof input.path === 'string' && path === undefined) {
    return undefined;
  }
  const keys = Object.keys(input).toSorted((left, right) => left.localeCompare(right));
  return `${tool} ${JSON.stringify(Object.fromEntries(keys.map((key) => [key, key === 'path' ? path : input[key]])))}`;
};

// §6.5 item 3: the key a call matches on. A Read matches on its normalized `file_path` only, a Grep or a
// Glob on its whole input. Undefined for a path above `/` and for every other tool: no match.
export const scopeKey = (tool: string, input: unknown): string | undefined => {
  if (!isArguments(input)) {
    return undefined;
  }
  if (tool === 'Read') {
    const path = typeof input.file_path === 'string' ? normalizePath(input.file_path) : undefined;
    return path === undefined ? undefined : `Read ${path}`;
  }
  return tool === 'Grep' || tool === 'Glob' ? searchKey(tool, input) : undefined;
};

// §6.5 item 6: the path the deny names; the tool name for a call that has none.
export const readScopeDeny = (tool: string, input: unknown): string => {
  const path = isArguments(input)
    ? [input.file_path, input.path, input.pattern].find((value) => typeof value === 'string')
    : undefined;
  return `Outside the watchdog read scope: ${typeof path === 'string' ? path : tool}. Do not retry this path. Review with what you have.`;
};

// §6.5 item 1: the check of a call the watchdog plugin raised, or of a known review agent's call.
export const isScopedCheck = (tool: string, originPlugin: string, isReviewAgent: boolean): boolean =>
  EXEMPT_TOOLS[tool] !== true && (originPlugin === 'watchdog' || isReviewAgent);

// §14.1: a key enters as the newest entry, once; past the cap the oldest entry goes out.
export const addEntry = (entries: AllowSet, key: string, cap = ALLOW_SET_CAP): AllowSet =>
  [...entries.filter((entry) => entry !== key), key].slice(-cap);

// Module memory; `$.state` keeps a copy, and a reload restores it once (§6.5 item 8).
const memory: { allow: AllowSet; denies: DenyCounts; isLoaded: boolean } = { allow: [], denies: {}, isLoaded: false };

export const allowSet = (): AllowSet => memory.allow;

export const denyCounts = (): DenyCounts => memory.denies;

export const allowCall = (key: string): void => {
  memory.allow = addEntry(memory.allow, key);
};

export const isAllowed = (key: string): boolean => memory.allow.includes(key);

export const addDeny = (slug: string): void => {
  memory.denies = { ...memory.denies, [slug]: (memory.denies[slug] ?? 0) + 1 };
};

export const isScopeLoaded = (): boolean => memory.isLoaded;

// Every writer waits for this read-back, so it finds the memory of this module instance still empty. A read-back
// that a session change overtook changes nothing.
export const restoreScope = (allow: AllowSet | undefined, denies: DenyCounts | undefined): void => {
  if (!memory.isLoaded) {
    memory.allow = allow ?? [];
    memory.denies = denies ?? {};
    memory.isLoaded = true;
  }
};

// §14.1, §14.3: a session change empties the allow set and the deny counts; the new `$.state` holds neither, so
// nothing is read back.
export const resetScope = (): void => {
  Object.assign(memory, { allow: [], denies: {}, isLoaded: true });
};
