// Stubs for an L2 test of a watched session: every `$` call and engine event the mod reaches.
import type { OnEvents } from '../../hooks/on';
import type { AgentSpec, CommandRunInput, ModelCompleteRequest, SessionAppendInput, ToolSpec } from 'claude-code';

export type SessionStubs = OnEvents<
  | 'session.version'
  | 'session.start'
  | 'command.register'
  | 'tool.register'
  | 'agent.register'
  | 'agent.offer'
  | 'agent.spawn'
  | 'fs.read'
  | 'model.complete'
  | 'turn.step'
  | 'turn.complete'
  | 'tool.call'
  | 'ui.log'
>;

export type Seen = {
  tools: ToolSpec[];
  agents: AgentSpec[];
  reads: string[];
  preflights: ModelCompleteRequest[];
  spawns: { prompt: string; subagentType?: string; description?: string }[];
  logs: string[];
  coreToolCalls: string[];
};

export const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const;

export const SYSTEM_TEMPLATE = 'BASE {{tool_sentence}} max {{max_notes_per_review}}.';

// The shipped `prompts/boundary-guidance.md` (§10.7), as `$.fs.read` returns it.
export const GUIDANCE = 'Weigh these notes.\n';

export const REVIEW_AGENT = 'afake0001';

// The agent that the core `Agent` tool stub starts.
export const AGENT_TOOL_AGENT = 'afake0002';

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

type Options = { preflightDeny?: string; noteDeny?: string };

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
  on('fs.read', (_$, e) => {
    seen.reads.push(e.path);
    return { value: e.path.endsWith('/prompts/boundary-guidance.md') ? GUIDANCE : SYSTEM_TEMPLATE };
  });
  on('model.complete', (_$, e) => {
    seen.preflights.push(e);
    return options.preflightDeny === undefined ? { value: answer('O') } : { deny: options.preflightDeny };
  });
};

const stubEngine = (on: SessionStubs, seen: Seen): void => {
  on('agent.offer', () => ({ isOffered: true }));
  // The kit hands the mod's own `$.agent.spawn` to the hooks in the Agent tool's input shape
  // (`subagent_type`), and resolves it to the mod as `{ model: 'inherit' }` without the id (spec §16.2).
  on('agent.spawn', (_$, e) => {
    const subagentType = 'subagent_type' in e ? e.subagent_type : e.subagentType;
    seen.spawns.push({ prompt: e.prompt, subagentType: String(subagentType), description: e.description });
    return { model: 'claude-opus-4-5', agentId: REVIEW_AGENT };
  });
  on('turn.step', async function* (_$, e) {
    yield* [];
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null };
  });
  on('turn.complete', (_$, e) => ({ text: e.answer }));
  on('tool.call', (_$, e) => {
    seen.coreToolCalls.push(e.tool);
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
};

// Registers every stub; call it before the test's first `$` call.
export const stubSession = (on: SessionStubs, options: Options = {}): Seen => {
  const seen: Seen = { tools: [], agents: [], reads: [], preflights: [], spawns: [], logs: [], coreToolCalls: [] };
  stubRegisters(on, seen, options);
  stubEngine(on, seen);
  return seen;
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
