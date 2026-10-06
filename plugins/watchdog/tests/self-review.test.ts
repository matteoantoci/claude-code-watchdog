import { describe, expect, test } from 'claude-code/testing';
import { isOwnLoop, isOwnPrompt, isOwnRow, isOwnSend, isOwnSpawn, isOwnToolCall } from '../hooks/agents/self-review';

const WATCHDOG = 'a1b2c3d4e5f6a7b8c';
const OTHER = 'aa00bb11cc22dd33e';
const IDLE = { ids: new Set([WATCHDOG]), isSpawnInFlight: false };
const SPAWNING = { ids: new Set([WATCHDOG]), isSpawnInFlight: true };
const PLUGIN_ID = 'toolu_plugin_0123456789abcdef0123456789abcdef';
const MODEL_ID = 'toolu_01Koq5WS2oCWoqTNpb6ZSpFe';

const textRow = (text: string) => ({
  door: 'response',
  origin: { kind: 'model', model: 'claude-opus-4-5' },
  message: { content: [{ type: 'text', text }] },
});

const notification = (id: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>${PLUGIN_ID}</tool-use-id>\n<status>completed</status>\n</task-notification>`;

describe('self-review filter, item 1: events of a watchdog loop', () => {
  test('a turn.step, tool.call or turn.complete of a watchdog id is its own', () => {
    expect(isOwnLoop(WATCHDOG, IDLE)).toBe(true);
    expect(isOwnToolCall({ tool: 'Read', tool_use_id: MODEL_ID, agentId: WATCHDOG }, IDLE)).toBe(true);
  });

  test('the main loop and another subagent are not', () => {
    expect(isOwnLoop(undefined, IDLE)).toBe(false);
    expect(isOwnLoop(OTHER, IDLE)).toBe(false);
  });

  test('a session.append row of a watchdog id is its own', () => {
    expect(isOwnRow({ ...textRow('found a bug'), agentId: WATCHDOG }, IDLE)).toBe(true);
    expect(isOwnRow({ ...textRow('found a bug'), agentId: OTHER }, IDLE)).toBe(false);
  });
});

describe('self-review filter, item 2: rows the watchdog plugin made', () => {
  test('a steer row and a nudge prompt row with the watchdog plugin origin are its own', () => {
    const steer = { door: 'note', origin: { kind: 'plugin', name: 'watchdog' }, message: { content: [] } };
    const nudge = { door: 'prompt', origin: { kind: 'plugin', name: 'watchdog' }, message: { content: [] } };
    expect(isOwnRow(steer, IDLE)).toBe(true);
    expect(isOwnRow(nudge, IDLE)).toBe(true);
  });

  test('a row of another plugin is not', () => {
    const row = { door: 'prompt', origin: { kind: 'plugin', name: 'other' }, message: { content: [] } };
    expect(isOwnRow(row, IDLE)).toBe(false);
  });
});

describe('self-review filter, item 3: the delivered notes', () => {
  test('a hook-context row that carries <watchdog-notes> is its own', () => {
    const aside = {
      door: 'hook-context',
      origin: { kind: 'plugin', event: 'prompt.submit' },
      message: {
        content: [{ type: 'text', text: '<watchdog-notes>\n<note severity="nit">x</note>\n</watchdog-notes>' }],
      },
    };
    expect(isOwnRow(aside, IDLE)).toBe(true);
  });

  test('a hook-context row of other text is not', () => {
    const other = {
      door: 'hook-context',
      origin: { kind: 'plugin', event: 'prompt.submit' },
      message: { content: [{ type: 'text', text: 'lint: 0 problems' }] },
    };
    expect(isOwnRow(other, IDLE)).toBe(false);
  });
});

describe('self-review filter, item 4: main-loop echoes of a mod spawn', () => {
  test('agent.spawn of a watchdog type is its own, of another type not', () => {
    expect(isOwnSpawn('watchdog:default')).toBe(true);
    expect(isOwnSpawn('Explore')).toBe(false);
  });

  test('a tool.call or tool.check of Agent for a watchdog type is its own', () => {
    const call = { tool: 'Agent', tool_use_id: PLUGIN_ID, subagent_type: 'watchdog:default' };
    expect(isOwnToolCall(call, IDLE)).toBe(true);
  });

  test('a plugin Agent call is matched by the spawn, not by the id prefix alone', () => {
    const call = { tool: 'Agent', tool_use_id: PLUGIN_ID, subagent_type: 'other-plugin:runner' };
    expect(isOwnToolCall(call, IDLE)).toBe(false);
  });

  test('a SendMessage or session.send to a watchdog id is its own', () => {
    expect(isOwnToolCall({ tool: 'SendMessage', tool_use_id: PLUGIN_ID, to: WATCHDOG }, IDLE)).toBe(true);
    expect(isOwnToolCall({ tool: 'SendMessage', tool_use_id: MODEL_ID, to: OTHER }, IDLE)).toBe(false);
    expect(isOwnSend({ to: WATCHDOG }, IDLE)).toBe(true);
    expect(isOwnSend({ to: OTHER }, IDLE)).toBe(false);
  });

  test('a TaskStop call with the watchdog origin is its own, the primary agent TaskStop is not', () => {
    const stop = { tool: 'TaskStop', tool_use_id: PLUGIN_ID, task_id: WATCHDOG };
    expect(isOwnToolCall(stop, IDLE, 'watchdog')).toBe(true);
    expect(isOwnToolCall({ ...stop, tool_use_id: MODEL_ID, task_id: OTHER }, IDLE, 'engine')).toBe(false);
  });

  test('a <task-notification> of a watchdog id is its own, of another agent not', () => {
    expect(isOwnPrompt(notification(WATCHDOG), IDLE)).toBe(true);
    expect(isOwnPrompt(notification(OTHER), IDLE)).toBe(false);
    const row = {
      door: 'prompt',
      origin: { kind: 'task-notification' },
      message: { content: [{ type: 'text', text: notification(WATCHDOG) }] },
    };
    expect(isOwnRow(row, IDLE)).toBe(true);
  });
});

describe('self-review filter, item 5: the synthetic Agent call of a spawn in flight', () => {
  test('while a spawn is in flight, a main-loop Agent call with a plugin id is its own', () => {
    const call = { tool: 'Agent', tool_use_id: PLUGIN_ID, subagent_type: 'other-plugin:runner' };
    expect(isOwnToolCall(call, SPAWNING)).toBe(true);
  });

  test('while a spawn is in flight, a main-loop Agent call of the model is not', () => {
    const call = { tool: 'Agent', tool_use_id: MODEL_ID, subagent_type: 'Explore' };
    expect(isOwnToolCall(call, SPAWNING)).toBe(false);
  });
});

describe('self-review filter, item 6: the stop prompt of a watchdog agent', () => {
  test('"Background agent … was stopped by the user." of a watchdog review is its own', () => {
    expect(isOwnPrompt('Background agent "watchdog default review" was stopped by the user.', IDLE)).toBe(true);
    const row = {
      door: 'prompt',
      origin: { kind: 'task-notification' },
      message: {
        content: [{ type: 'text', text: 'Background agent "watchdog default review" was stopped by the user.' }],
      },
    };
    expect(isOwnRow(row, IDLE)).toBe(true);
  });

  test('the stop prompt of a subagent of the primary agent is not', () => {
    expect(isOwnPrompt('Background agent "explore auth flow" was stopped by the user.', IDLE)).toBe(false);
  });
});

describe('self-review filter: the primary agent work stays', () => {
  test('a model row, a person prompt and a model tool call are not its own', () => {
    expect(isOwnRow(textRow('I will fix the parser.'), IDLE)).toBe(false);
    const prompt = {
      door: 'prompt',
      origin: { kind: 'composer' },
      message: { content: [{ type: 'text', text: 'fix it' }] },
    };
    expect(isOwnRow(prompt, SPAWNING)).toBe(false);
    expect(isOwnToolCall({ tool: 'Read', tool_use_id: MODEL_ID, file_path: 'a.ts' }, SPAWNING)).toBe(false);
  });
});
