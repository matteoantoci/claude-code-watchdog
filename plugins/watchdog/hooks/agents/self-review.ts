// Spec §7.3: the watchdog never reviews itself. Each predicate answers for one kind of event.
import { STOPPED_REVIEW_PROMPT, TYPE_PREFIX } from './spec';

// The watchdog id set (a Set, or the Map of agentId → watchdog) and whether a `$.agent.spawn` of the
// mod is in flight (§7.3).
export type OwnContext = {
  readonly ids: { readonly has: (agentId: string) => boolean };
  readonly isSpawnInFlight: boolean;
};

type Row = {
  readonly agentId?: string;
  readonly door: string;
  readonly origin: { readonly kind: string; readonly name?: string };
  readonly message: { readonly content: readonly { readonly type: string; readonly text?: unknown }[] };
};

// A tool.call or tool.check input: the tool, its id, the loop, and the tool's own arguments.
type ToolCall = {
  readonly tool: string;
  readonly tool_use_id?: string;
  readonly agentId?: string;
  readonly subagent_type?: unknown;
  readonly to?: unknown;
  readonly [argument: string]: unknown;
};

const PLUGIN = 'watchdog';
const PLUGIN_TOOL_USE_ID = 'toolu_plugin_';
const TASK_ID = /<task-id>([^<]*)<\/task-id>/u;

const isId = (value: unknown, own: OwnContext): boolean => typeof value === 'string' && own.ids.has(value);

// Item 1: a turn.step, tool.call, turn.complete or session.append of a watchdog agent.
export const isOwnLoop = (agentId: string | undefined, own: OwnContext): boolean => isId(agentId, own);

// Item 4: agent.spawn of a watchdog type.
export const isOwnSpawn = (subagentType: unknown): subagentType is string =>
  typeof subagentType === 'string' && subagentType.startsWith(TYPE_PREFIX);

// Item 4: session.send to a watchdog agent; item 1: a send from one.
export const isOwnSend = (send: { readonly to: string; readonly agentId?: string }, own: OwnContext): boolean =>
  isId(send.to, own) || isId(send.agentId, own);

// Items 4 and 6: a <task-notification> of a watchdog agent, and the stop prompt of a watchdog review.
export const isOwnPrompt = (text: string, own: OwnContext): boolean =>
  (text.startsWith('<task-notification>') && isId(TASK_ID.exec(text)?.[1], own)) || STOPPED_REVIEW_PROMPT.test(text);

// Items 1, 2, 3, and the prompts of items 4 and 6, for a session.append row. Item 3 also covers the engine's
// `notice` echo of each `$.ui.log` row, which it leads with the plugin's name (live probe l3-self-review-log-rows).
export const isOwnRow = (row: Row, own: OwnContext): boolean => {
  if (isId(row.agentId, own) || (row.origin.kind === 'plugin' && row.origin.name === PLUGIN)) {
    return true;
  }
  const text = row.message.content.map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n');
  return (
    (row.door === 'hook-context' && text.includes('<watchdog-notes>')) ||
    (row.door === 'notice' && text.startsWith(`${PLUGIN}: `)) ||
    isOwnPrompt(text, own)
  );
};

// Items 1, 4 and 5 for a tool.call or tool.check; `originPlugin` is `next.origin.plugin`.
export const isOwnToolCall = (call: ToolCall, own: OwnContext, originPlugin = 'engine'): boolean => {
  if (isId(call.agentId, own)) {
    return true;
  }
  if (call.tool === 'Agent') {
    const isPluginCall = call.tool_use_id?.startsWith(PLUGIN_TOOL_USE_ID) === true;
    return isOwnSpawn(call.subagent_type) || (own.isSpawnInFlight && isPluginCall);
  }
  if (call.tool === 'SendMessage') {
    return isId(call.to, own);
  }
  return call.tool === 'TaskStop' && originPlugin === PLUGIN;
};
