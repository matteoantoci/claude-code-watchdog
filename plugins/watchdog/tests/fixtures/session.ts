// Stubs for an L2 test of a watched session: every `$` call and engine event the mod reaches.
import { REVIEW_TIMEOUT_MS } from '../../hooks/constants';
import { FRAGMENTS } from './prompts';
import type { OnEvents } from '../../hooks/on';
import type {
  AgentSpawnInput,
  AgentSpec,
  ApiMessage,
  CommandRunInput,
  ContextMemoryFile,
  ModelCompleteRequest,
  SessionAppendInput,
  SessionMessage,
  SessionUsage,
  Settings,
  SettingsSource,
  ToolSpec,
  TurnStepResult,
  TurnStepServerToolUse,
} from 'claude-code';

export type SessionEvents =
  | 'session.version'
  | 'session.start'
  | 'command.register'
  | 'tool.register'
  | 'agent.register'
  | 'agent.offer'
  | 'agent.spawn'
  | 'fs.read'
  | 'fs.stat'
  | 'fs.list'
  | 'fs.exists'
  | 'session.usage'
  | 'env.get'
  | 'env.set'
  | 'settings.read'
  | 'session.cwd'
  | 'session.root'
  | 'session.repo'
  | 'model.complete'
  | 'turn.step'
  | 'turn.complete'
  | 'tool.call'
  | 'ui.log'
  | 'session.id'
  | 'session.messages'
  | 'store.get'
  | 'store.set'
  | 'store.keys'
  | 'store.delete'
  | 'clock.now';

export type SessionStubs = OnEvents<SessionEvents>;

export type Seen = {
  tools: ToolSpec[];
  agents: AgentSpec[];
  reads: string[];
  preflights: ModelCompleteRequest[];
  spawns: { prompt: string; subagentType: string; description?: string }[];
  logs: string[];
  coreToolCalls: string[];
  // The `task_id` of each `TaskStop` call (§7.8), oldest first.
  taskStops: string[];
  // What `$.store` holds (store key → value), as JSON round trips it.
  store: Map<string, unknown>;
  // Each key `$.store.delete` removed, oldest first.
  storeDeletes: string[];
  // Each `$.env.set` as [name, value]; an undefined value unsets.
  envSets: [string, string | undefined][];
  // The source of each `$.settings.read`; undefined for the merge.
  settingsReads: (SettingsSource | undefined)[];
};

export const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const;

// §5.3: a `-p` (or SDK) session.
export const HEADLESS_START = { cwd: '/repo', surface: null, isInteractive: false } as const;

// The workspace of every L2 session: `$HOME` is /home/me, and the cwd /repo is the git root and the session
// root. So the user file is /home/me/.claude/WATCHDOG.json, the project files /repo/.claude/WATCHDOG.json and
// /repo/WATCHDOG.json (spec §4.3).
export const HOME = '/home/me';

// A file of the workspace; a test may change it after the mod read it.
export type WorkspaceFile = { text: string; mtimeMs: number };

export const SYSTEM_TEMPLATE = 'BASE {{tool_sentence}} max {{max_notes_per_review}}.';

// The shipped `prompts/boundary-guidance.md` (§10.7), as `$.fs.read` returns it.
export const GUIDANCE = 'Weigh these notes.\n';

export const REVIEW_AGENT = 'afake0001';

// What `$.clock.now()` resolves: 2026-10-06T09:05:03Z.
export const NOW = Date.UTC(2026, 9, 6, 9, 5, 3);

// The agent that the core `Agent` tool stub starts.
export const AGENT_TOOL_AGENT = 'afake0002';

// The agent that the engine starts for a spawn of another type than a review: `asub` and the last 4 chars of
// its `tool_use_id`, so the subagents of one test get distinct ids.
export const subagentId = (toolUseId: string): string => `asub${toolUseId.slice(-4)}`;

// With `isReviewIdPerSpawn`, the agent of a review spawn: `arev` and the last 4 chars of its `tool_use_id`, so
// the reviews that run at once get distinct ids (§7.5).
export const reviewAgentId = (toolUseId: string): string => `arev${toolUseId.slice(-4)}`;

export const USAGE = {
  input_tokens: 1200,
  output_tokens: 80,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'claude-opus-4-5',
};

export const typed = (args: string): CommandRunInput => ({
  command: 'watchdog',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
});

const answer = (text: string) => ({
  isAnswered: true as const,
  text,
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

type Options = {
  preflightDeny?: string;
  noteDeny?: string;
  store?: ReadonlyMap<string, unknown>;
  storeSetDeny?: string;
  // What `$.session.messages({ as: 'api' })` resolves: the main conversation in Messages API form.
  messages?: readonly ApiMessage[];
  // The server tool calls of each step result (`serverToolUses`).
  serverToolUses?: readonly TurnStepServerToolUse[];
  files?: Record<string, WorkspaceFile>;
  // What `$.env.get` answers; a name not listed is unset. Default: `HOME` only. `$.env.set` changes it.
  env?: Readonly<Record<string, string>>;
  // What `$.settings.read({ source })` answers for each source; a source not listed answers `{}`.
  settings?: Partial<Record<SettingsSource, Settings>>;
  // The reason each `agent.spawn` denies with, after it is seen. A throw in a stub only skips it, so a deny
  // stands in for a reject: the mod handles both the same.
  spawnDeny?: string;
  // §8.2: the memory files of the session's context, as `$.session.usage` lists them. Default: none.
  memoryFiles?: readonly ContextMemoryFile[];
  // `$.session.repo()` answers null: the cwd /repo is outside git.
  isOutsideGit?: boolean;
  // The caller answers `$.clock` with `mock.clock` (./delivery), so this fixture leaves `clock.now` alone.
  isClockMocked?: true;
  // What `$.clock.now()` resolves, read at each call; default `NOW`. A test moves it without `mock.clock`.
  now?: () => number;
  // §7.8: the reason each `TaskStop` call denies with, after it is seen; and what runs as it arrives.
  taskStopDeny?: string;
  onTaskStop?: () => void;
  // What `$.session.id()` resolves, read at each call; default `SESSION_ID`. A test switches the session with it.
  sessionId?: () => string;
  // What `$.session.messages()` resolves, read at each call: the main conversation as `SessionMessage` rows.
  // Default: none.
  transcript?: () => readonly SessionMessage[];
  // §7.5: each `watchdog:*` spawn starts its own agent, `reviewAgentId(tool_use_id)`. Default: every review
  // agent is `REVIEW_AGENT`.
  isReviewIdPerSpawn?: true;
};

// `$.session.usage({ breakdown: 'summary' })` with the given memory files; the other figures are zeros.
const usage = (memoryFiles: readonly ContextMemoryFile[]): SessionUsage => ({
  startedAt: NOW,
  rateLimits: [],
  context: {
    window: 200_000,
    breakdown: {
      categories: [],
      totalTokens: 0,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      autocompactSource: 'model-default',
      percentage: 0,
      gridRows: [],
      model: 'claude-opus-4-5',
      memoryFiles: [...memoryFiles],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: true,
      apiUsage: null,
    },
  },
});

// The entries of directory `dir` in a workspace given as file paths: a name with more path below it is a dir.
const listDir = (paths: readonly string[], dir: string) => {
  const below = paths.filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1));
  const names = [...new Set(below.map((rest) => rest.split('/')[0] ?? ''))];
  return names.map((name) => ({
    name,
    kind: below.includes(name) ? ('file' as const) : ('dir' as const),
    size: 0,
    mtimeMs: 0,
    isLink: false,
  }));
};

export const SESSION_ID = 'c0ffee00-0000-4000-8000-000000000001';

// `$.session.id`, the main conversation, and a `$.store` in memory that round trips each value through JSON.
const stubStore = (on: SessionStubs, seen: Seen, options: Options): void => {
  on('session.id', () => ({ value: options.sessionId?.() ?? SESSION_ID }));
  on('session.messages', (_$, e) =>
    e.as === undefined && e.agentId === undefined
      ? { value: [...(options.transcript?.() ?? [])] }
      : { value: [...(options.messages ?? [])] }
  );
  on('store.get', (_$, e) => ({ value: seen.store.get(e.key) }));
  on('store.set', (_$, e) => {
    if (options.storeSetDeny !== undefined) {
      return { deny: options.storeSetDeny };
    }
    seen.store.set(e.key, JSON.parse(JSON.stringify(e.value)) as unknown);
    return { value: undefined };
  });
  on('store.keys', () => ({ value: [...seen.store.keys()] }));
  on('store.delete', (_$, e) => {
    seen.storeDeletes.push(e.key);
    seen.store.delete(e.key);
    return { value: undefined };
  });
};

// `$.env`, and the workspace: every path not in `files` is missing, and a directory exists when a file is
// below it. `fs.read` of another path answers the shipped prompt it names.
const stubWorkspace = (on: SessionStubs, seen: Seen, options: Options): void => {
  const env = new Map(Object.entries(options.env ?? { HOME }));
  const files = options.files ?? {};
  const paths = Object.keys(files);
  on('env.get', (_$, e) => ({ value: env.get(e.name) }));
  on('env.set', (_$, e) => {
    seen.envSets.push([e.name, e.value]);
    if (e.value === undefined) {
      env.delete(e.name);
    } else {
      env.set(e.name, e.value);
    }
    return { value: undefined };
  });
  on('settings.read', (_$, e) => {
    seen.settingsReads.push(e.source);
    return { value: (e.source === undefined ? undefined : options.settings?.[e.source]) ?? {} };
  });
  on('session.cwd', () => ({ value: START.cwd }));
  on('session.root', () => ({ value: START.cwd }));
  on('session.repo', () => ({
    value: options.isOutsideGit === true ? null : { root: START.cwd, remote: null, internal: false, name: null },
  }));
  on('session.usage', () => ({ value: usage(options.memoryFiles ?? []) }));
  on('fs.stat', (_$, e) => {
    const file = files[e.path];
    return file === undefined
      ? { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
      : { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } };
  });
  on('fs.list', (_$, e) => ({ value: listDir(paths, e.path ?? START.cwd) }));
  on('fs.exists', (_$, e) => ({ value: paths.some((path) => path === e.path || path.startsWith(`${e.path}/`)) }));
  on('fs.read', (_$, e) => {
    seen.reads.push(e.path);
    const name = e.path.slice(e.path.lastIndexOf('/') + 1);
    const shipped = name === 'boundary-guidance.md' ? GUIDANCE : (FRAGMENTS[name] ?? SYSTEM_TEMPLATE);
    return { value: files[e.path]?.text ?? shipped };
  });
};

const stubRegisters = (on: SessionStubs, seen: Seen, options: Options): void => {
  on('session.version', () => ({ value: { version: '2.1.290', base: '2.1.290' } }));
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('command.register', (_$, e) => ({ value: { command: e.name } }));
  on('tool.register', (_$, e) => {
    seen.tools.push(e);
    return options.noteDeny === undefined
      ? { value: { tool: `mcp__watchdog__${e.name}` } }
      : { deny: options.noteDeny };
  });
  on('agent.register', (_$, e) => {
    seen.agents.push(e);
    return { value: { agent: `watchdog:${e.name}` } };
  });
  stubWorkspace(on, seen, options);
  on('model.complete', (_$, e) => {
    seen.preflights.push(e);
    return options.preflightDeny === undefined ? { value: answer('O') } : { deny: options.preflightDeny };
  });
};

// §16.2: the model id the engine runs an agent on: the roster model the mod registered for its `watchdog:*`
// type, an alias as a full id that contains it (§12.2), a full id as is; `claude-opus-4-5` for another type.
const MODEL_IDS: Readonly<Record<string, string>> = {
  opus: 'claude-opus-4-5',
  sonnet: 'claude-sonnet-4-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-4-5',
};

const spawnModel = (seen: Seen, subagentType: string): string => {
  const model = seen.agents.findLast((agent) => `watchdog:${agent.name}` === subagentType)?.model ?? 'opus';
  return MODEL_IDS[model] ?? model;
};

// The kit drops the id of the mod's own spawn (the Agent tool shape, which has no `tool_use_id`), so only a
// review spawn the test fires in the engine's shape gets an id of its own.
const spawnAgentId = (subagentType: string, e: AgentSpawnInput, options: Options): string => {
  if (!subagentType.startsWith('watchdog:')) {
    return subagentId(e.tool_use_id);
  }
  const isOwnId = options.isReviewIdPerSpawn !== undefined && !('subagent_type' in e);
  return isOwnId ? reviewAgentId(e.tool_use_id) : REVIEW_AGENT;
};

const stubEngine = (on: SessionStubs, seen: Seen, options: Options): void => {
  on('agent.offer', () => ({ isOffered: true }));
  // The kit hands the mod's own `$.agent.spawn` to the hooks in the Agent tool's input shape
  // (`subagent_type`), and resolves it to the mod as `{ model: 'inherit' }` without the id (spec §16.2).
  on('agent.spawn', (_$, e) => {
    const subagentType = String('subagent_type' in e ? e.subagent_type : e.subagentType);
    seen.spawns.push({ prompt: e.prompt, subagentType, description: e.description });
    const agentId = spawnAgentId(subagentType, e, options);
    return options.spawnDeny === undefined
      ? { model: spawnModel(seen, subagentType), agentId }
      : { deny: options.spawnDeny };
  });
  on('turn.step', async function* (_$, e) {
    yield* [];
    const step: TurnStepResult = {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: null,
    };
    return options.serverToolUses === undefined ? step : { ...step, serverToolUses: options.serverToolUses };
  });
  on('turn.complete', (_$, e) => ({ text: e.answer }));
  on('tool.call', (_$, e) => {
    seen.coreToolCalls.push(e.tool);
    if (e.tool === 'TaskStop') {
      seen.taskStops.push(String(e.task_id));
      options.onTaskStop?.();
      return options.taskStopDeny === undefined
        ? { result: 'Successfully stopped task' }
        : { deny: options.taskStopDeny };
    }
    return e.tool === 'Agent'
      ? {
          result: { status: 'async_launched', agentId: AGENT_TOOL_AGENT, description: e.description, prompt: e.prompt },
        }
      : { result: 'core' };
  });
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text);
    return { value: undefined };
  });
  if (options.isClockMocked === undefined) {
    on('clock.now', () => ({ value: options.now?.() ?? NOW }));
  }
};

// Registers every stub; call it before the test's first `$` call.
export const stubSession = (on: SessionStubs, options: Options = {}): Seen => {
  const seen: Seen = {
    tools: [],
    agents: [],
    reads: [],
    preflights: [],
    spawns: [],
    logs: [],
    coreToolCalls: [],
    taskStops: [],
    store: new Map(options.store),
    storeDeletes: [],
    envSets: [],
    settingsReads: [],
  };
  stubRegisters(on, seen, options);
  stubEngine(on, seen, options);
  stubStore(on, seen, options);
  return seen;
};

// `$.clock.after` answered at once, so a delayed log row lands before the command resolves; `delays` gets the
// wait of each. The 10 min review timer (§7.8) is refused, as a reload drops it, so no review times out.
export const stubAfterAtOnce = (on: OnEvents<'clock.after'>, delays: number[] = []): number[] => {
  on('clock.after', (_$, e) => {
    if (e.ms === REVIEW_TIMEOUT_MS) {
      return { deny: 'the review timer waits' };
    }
    delays.push(e.ms);
    return { value: undefined };
  });
  return delays;
};

// A main-loop row as the engine appends it. The kit has nothing beneath the plugins for
// `session.append`, so the call rejects after the mod's hooks saw the row.
export const mainRow = (uuid: string, role: 'user' | 'assistant', text: string): SessionAppendInput => ({
  uuid,
  door: role === 'user' ? 'prompt' : 'response',
  origin: role === 'user' ? { kind: 'composer' } : { kind: 'model', model: 'claude-opus-4-5' },
  message: { type: role, role, content: [{ type: 'text', text }] },
});

export const turnEnd = (turnId: string) =>
  ({ turnId, reason: 'answer', answer: 'done', durationMs: 5, isAborted: false }) as const;
