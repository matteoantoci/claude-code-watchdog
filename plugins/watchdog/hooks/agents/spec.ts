import { MAX_TURNS } from '../constants';
import { WATCHDOG_TOOLS } from '../note/tool';
import { resolveEffort } from '../roster/model';
import type { SessionEffort } from '../roster/model';
import type { Watchdog } from './roster';
import type { AgentSpec } from 'claude-code';

export const TYPE_PREFIX = 'watchdog:';

// §8.3, §10.8: the model calls each tool of the mod (`note`, `resolve`) as `mcp__watchdog__<name>`; each watchdog
// has them all, whatever its roster entry lists.
export const WATCHDOG_TOOL_NAMES: readonly string[] = WATCHDOG_TOOLS.map((tool) => `mcp__watchdog__${tool.name}`);

// §6.1: `disallowedTools` removes the mutating tools from the agent's request.
const DISALLOWED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit'];

export const agentType = (slug: string): string => `${TYPE_PREFIX}${slug}`;

// The spawn `description`; /tasks shows it, and the engine quotes it when the person stops the agent.
export const reviewDescription = (watchdog: Watchdog): string => `watchdog ${watchdog.name} review`;

// §7.3 item 6: the prompt the engine sends when the person stops a review agent.
export const STOPPED_REVIEW_PROMPT = /^Background agent "watchdog .+ review" was stopped by the user\.$/u;

// §6.1: one hidden agent type for each watchdog; `prompt` is the filled base (§8.1), which the guidance area's
// `agent.register` hook completes into the whole system prompt. §6.2: the effort is always sent, and `auto`
// takes the session effort of now.
export const agentSpec = (watchdog: Watchdog, prompt: string, session: SessionEffort): AgentSpec => ({
  name: watchdog.slug,
  description: `Watchdog ${watchdog.name}: reviews the primary agent's updates. Only the watchdog plugin spawns it.`,
  prompt,
  tools: [...watchdog.tools, ...WATCHDOG_TOOL_NAMES],
  disallowedTools: DISALLOWED_TOOLS,
  model: watchdog.model,
  effort: resolveEffort(watchdog.effort, session),
  maxTurns: MAX_TURNS,
  omitClaudeMd: true,
});
