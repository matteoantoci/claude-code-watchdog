// The engine's `tool.check` of the mod's own review spawn (spec §6.1, §6.5): the main loop's synthetic `Agent`
// call, with no `agentId` and no `ceiling`, origin `{ plugin: 'watchdog', tier: 'user' }`. Recorded on Claude Code
// 2.1.293 in the TUI with `--permission-mode auto`, a roster watchdog `default` on `haiku`. Source: the observer's
// `tool.check` record. Scrubbed: the review prompt (3196 characters) and the hex of the tool use id.
import type { ToolCheckInput } from 'claude-code';

export const SPAWN_CHECK = {
  tool: 'Agent',
  input: { description: 'watchdog default review', prompt: 'review', subagent_type: 'watchdog:default' },
  tool_use_id: 'toolu_plugin_00000000000000000000000000000001',
} satisfies ToolCheckInput;
