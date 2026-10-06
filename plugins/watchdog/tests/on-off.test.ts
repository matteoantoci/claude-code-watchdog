import { describe, expect, test } from 'claude-code/testing';
import { START, stubSession, typed } from './fixtures/session';
import type { SessionStubs } from './fixtures/session';

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    note: {
      type: 'string',
      description: 'One concrete piece of advice for the agent you are watching. Terse, specific, actionable.',
    },
    severity: {
      enum: ['nit', 'concern', 'blocker'],
      description: 'How strongly to weigh this. Use `nit` for non-urgent cleanup.',
    },
  },
  required: ['note', 'severity'],
};

describe('/watchdog on', () => {
  test('registers the note tool and the watchdog:default agent, then runs one 1-token preflight', async ($, on: SessionStubs) => {
    const seen = stubSession(on);
    await $.session.start(START);
    const registeredAtStart = seen.tools.length;
    const reply = await $.command.run(typed('on'));

    expect(seen.tools.slice(registeredAtStart)).toEqual([
      {
        name: 'note',
        description: [
          'Watched agent: send 1 concrete, terse advice.',
          'Use sparingly; stay silent when nothing matters.',
          'Call to avert likely-wrong or materially wasteful work.',
        ].join('\n'),
        inputSchema: NOTE_SCHEMA,
      },
    ]);
    expect(seen.reads.map((path) => path.slice(path.lastIndexOf('/prompts/')))).toEqual([
      '/prompts/system.md',
      '/prompts/context-files.md',
      '/prompts/memory-context.md',
      '/prompts/active-repo-watchdog.md',
    ]);
    expect(seen.agents).toEqual([
      {
        name: 'default',
        description: expect.any(String),
        prompt: 'BASE Granted tools: `Read`, `Grep`, `Glob`. max 4.',
        tools: ['Read', 'Grep', 'Glob', 'mcp__watchdog__note'],
        disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit'],
        model: 'opus',
        effort: 'medium',
        maxTurns: 12,
        omitClaudeMd: true,
      },
    ]);
    expect(seen.preflights).toEqual([{ model: 'opus', prompt: expect.any(String), maxTokens: 1 }]);
    expect(reply.text).toBe('watchdog on · nudge 0/1 · cooldown 0\non source: /watchdog on\ndefault idle');
  });

  test('agent.offer hides each watchdog type from the model and passes other types', async ($, on: SessionStubs) => {
    stubSession(on);
    const provider = { plugin: 'watchdog', tier: 'user' } as const;
    const hidden = await $.agent.offer({ agent: 'watchdog:default', description: 'x', source: 'plugin', provider });
    const shown = await $.agent.offer({ agent: 'Explore', description: 'x', source: 'built-in', provider });
    expect(hidden).toEqual({ isOffered: false });
    expect(shown).toEqual({ isOffered: true });
  });

  test('a preflight the engine refuses puts the watchdog in no_model with the reason', async ($, on: SessionStubs) => {
    stubSession(on, { preflightDeny: 'model opus is not in availableModels' });
    await $.session.start(START);
    await $.command.run(typed('on'));
    const status = await $.command.run(typed('status'));
    expect(status.text).toMatch(
      /^watchdog on · nudge 0\/1 · cooldown 0\non source: \/watchdog on\ndefault no_model: .*model opus is not in availableModels$/u
    );
  });

  test('a refused note register puts the watchdog in blocked with the reason', async ($, on: SessionStubs) => {
    stubSession(on, { noteDeny: 'allowedMcpServers refuses watchdog' });
    await $.session.start(START);
    await $.command.run(typed('on'));
    const status = await $.command.run(typed('status'));
    expect(status.text).toMatch(
      /^watchdog on · nudge 0\/1 · cooldown 0\non source: \/watchdog on\ndefault blocked: .*allowedMcpServers refuses watchdog$/u
    );
  });
});

describe('/watchdog off', () => {
  test('the reply and the status show off', async ($, on: SessionStubs) => {
    stubSession(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    const reply = await $.command.run(typed('off'));
    const status = await $.command.run(typed('status'));
    expect(reply.text).toBe('watchdog off');
    expect(status.text).toBe('watchdog off');
  });
});
