import { describe, expect, test } from 'claude-code/testing';
import { REVIEW_SPAWN } from './fixtures/delivery';
import { allowlistDeny, allowlistReject } from './fixtures/recorded';
import { REVIEW_AGENT, START, USAGE, mainRow, stubAfterAtOnce, stubSession, turnEnd, typed } from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { SessionEvents, SessionStubs } from './fixtures/session';

// §12.5: the row of a problem state from a `command.run` hook waits 300 ms (§13.2); the stub runs it at once.
type DelayStubs = OnEvents<SessionEvents | 'clock.after'>;

// The status head while on from `/watchdog on`; the roster lines follow it.
const ON_HEAD = 'watchdog on · nudge 0/1 · blocker 0/2 · cooldown 0\non source: /watchdog on';

// A project roster of one watchdog on a full model id.
const PINNED = {
  '/repo/WATCHDOG.json': {
    text: JSON.stringify({ watchdogs: [{ name: 'pinned', model: 'claude-opus-4-5' }] }),
    mtimeMs: 1,
  },
};

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
  test('registers the note and resolve tools and the watchdog:default agent, then runs one 1-token preflight', async ($, on: SessionStubs) => {
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
      {
        name: 'resolve',
        description: [
          'Retract one of your open notes that no longer holds.',
          "It leaves the person's band; a note not yet delivered never reaches the agent.",
        ].join('\n'),
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The id of an open note, as your notes so far list it.' },
            reason: { type: 'string', description: 'Why the note no longer holds, in one short sentence.' },
          },
          required: ['id', 'reason'],
        },
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
        tools: ['Read', 'Grep', 'Glob', 'mcp__watchdog__note', 'mcp__watchdog__resolve'],
        disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit'],
        model: 'opus',
        effort: 'medium',
        maxTurns: 12,
        omitClaudeMd: true,
      },
    ]);
    expect(seen.preflights).toEqual([{ model: 'opus', prompt: expect.any(String), maxTokens: 1 }]);
    expect(reply.text).toBe(`${ON_HEAD}\ndefault idle`);
  });

  test('agent.offer hides each watchdog type from the model and passes other types', async ($, on: SessionStubs) => {
    stubSession(on);
    const provider = { plugin: 'watchdog', tier: 'user' } as const;
    const hidden = await $.agent.offer({ agent: 'watchdog:default', description: 'x', source: 'plugin', provider });
    const shown = await $.agent.offer({ agent: 'Explore', description: 'x', source: 'built-in', provider });
    expect(hidden).toEqual({ isOffered: false });
    expect(shown).toEqual({ isOffered: true });
  });

  test('a preflight the engine refuses puts a full-id watchdog in no_model with the reason and one row', async ($, on: DelayStubs) => {
    const seen = stubSession(on, { preflightDeny: allowlistDeny('claude-opus-4-5'), files: PINNED });
    on('clock.after', () => ({ value: undefined }));
    await $.session.start(START);
    await $.command.run(typed('on'));
    const reason = allowlistReject('claude-opus-4-5');
    expect((await $.command.run(typed('status'))).text).toBe(
      `${ON_HEAD}\npinned no_model: ${reason} · ./WATCHDOG.json`
    );
    expect(seen.logs).toEqual([`watchdog: pinned no_model: ${reason}`]);
  });

  test('a preflight reject of an alias leaves it to the review-time compare, which takes the stepped-down model', async ($, on: DelayStubs) => {
    const roster = { watchdogs: [{ name: 'probe', model: 'sonnet' }] };
    const files = { '/repo/WATCHDOG.json': { text: JSON.stringify(roster), mtimeMs: 1 } };
    // The engine's reject under an `availableModels` allowlist, as recorded (live probe rf-allow-settings).
    const seen = stubSession(on, { preflightDeny: allowlistDeny('sonnet'), files });
    stubAfterAtOnce(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    expect((await $.command.run(typed('status'))).text).toBe(`${ON_HEAD}\nprobe idle · ./WATCHDOG.json`);

    await $.session.append(mainRow('u1', 'user', 'Fix the parser.')).catch(() => undefined);
    await $.turn.complete(turnEnd('t1'));
    await $.agent.spawn({ ...REVIEW_SPAWN, subagentType: 'watchdog:probe', description: 'watchdog probe review' });
    // The spawn ran on the newest allowed sonnet.
    await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, usage: { ...USAGE, model: 'claude-sonnet-4-6' } });
    expect(seen.spawns[0]?.subagentType).toBe('watchdog:probe');
    expect((await $.command.run(typed('status'))).text).toBe(`${ON_HEAD}\nprobe idle · ./WATCHDOG.json`);
    expect(seen.logs).toEqual([]);
  });

  test('a refused note register puts the watchdog in blocked with the reason and one row', async ($, on: DelayStubs) => {
    const seen = stubSession(on, { noteDeny: 'allowedMcpServers refuses watchdog' });
    on('clock.after', () => ({ value: undefined }));
    await $.session.start(START);
    await $.command.run(typed('on'));
    const status = await $.command.run(typed('status'));
    expect(status.text).toMatch(
      /^watchdog on · nudge 0\/1 · blocker 0\/2 · cooldown 0\non source: \/watchdog on\ndefault blocked: .*allowedMcpServers refuses watchdog$/u
    );
    expect(seen.logs).toEqual([
      expect.stringMatching(/^watchdog: default blocked: .*allowedMcpServers refuses watchdog$/u),
    ]);
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
