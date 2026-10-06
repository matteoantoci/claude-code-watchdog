import { NOTE_TOOL_NAME } from '../agents/spec';

// §6.4: the deny texts (build-session choice: short plain strings).
export const forkDeny = 'The watchdog plugin runs no tools for a fork of its review agents.';

export const toolDeny = (tool: string): string => `A watchdog cannot run ${tool}: it is not in this watchdog's tools.`;

// §6.4, for a `tool.call` of a loop with an `agentId`. `tools` is the watchdog's tool list when that loop
// is a known review agent, else undefined. A review agent runs only its own tools and `note`; any other
// loop the watchdog plugin raised is a fork (the engine summary fork) and runs nothing. Undefined: no deny.
export const guardDeny = (
  tool: string,
  tools: readonly string[] | undefined,
  isPluginOrigin: boolean
): string | undefined => {
  if (tools !== undefined) {
    return tool === NOTE_TOOL_NAME || tools.includes(tool) ? undefined : toolDeny(tool);
  }
  return isPluginOrigin ? forkDeny : undefined;
};
