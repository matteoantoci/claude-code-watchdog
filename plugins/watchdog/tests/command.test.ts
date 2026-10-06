import { describe, expect, test } from 'claude-code/testing';
import type { OnEvents } from '../hooks/on';
import type { CommandRunInput } from 'claude-code';

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const;

type Stubs = OnEvents<'session.version' | 'command.register' | 'tool.register' | 'session.start' | 'ui.log'>;

const startOn = (on: Stubs, base: string): void => {
  on('session.version', () => ({ value: { version: base, base } }));
  on('command.register', () => ({ value: { command: 'watchdog' } }));
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__watchdog__${e.name}` } }));
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
};

const typed = (args: string): CommandRunInput => ({
  command: 'watchdog',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
});

describe('/watchdog command', () => {
  test('below 2.1.290, /watchdog on replies that Claude Code needs an update', async ($, on) => {
    startOn(on, '2.1.289');
    await $.session.start(START);
    const reply = await $.command.run(typed('on'));
    expect(reply.text).toBe('needs Claude Code 2.1.290 or later; update the Claude app');
  });

  test('a bare /watchdog and /watchdog status show the same short status', async ($, on) => {
    startOn(on, '2.1.290');
    await $.session.start(START);
    const bare = await $.command.run(typed(''));
    const status = await $.command.run(typed('status'));
    expect(bare.text).toBe('watchdog off');
    expect(status.text).toBe('watchdog off');
  });

  test('below 2.1.290, the status says unsupported and why', async ($, on) => {
    startOn(on, '2.1.289');
    await $.session.start(START);
    const status = await $.command.run(typed('status'));
    expect(status.text).toBe('watchdog unsupported: needs Claude Code 2.1.290 or later; update the Claude app');
  });

  test('an unknown subcommand replies with the usage', async ($, on) => {
    startOn(on, '2.1.290');
    await $.session.start(START);
    const reply = await $.command.run(typed('of'));
    expect(reply.text).toBe('usage: /watchdog [on|off|status|dump [raw]]');
  });

  test('/watchdog on <prompt> takes no prompt: it replies with the usage and the session stays off (§3)', async ($, on) => {
    startOn(on, '2.1.290');
    await $.session.start(START);
    const reply = await $.command.run(typed('on fix the parser'));
    expect(reply.text).toBe('usage: /watchdog [on|off|status|dump [raw]]');
    expect((await $.command.run(typed('status'))).text).toBe('watchdog off');
  });
});

describe('/watchdog registration', () => {
  test('session.start registers the note tool after the version gate, the command last', async ($, on: Stubs) => {
    const calls: string[] = [];
    on('session.version', () => {
      calls.push('session.version');
      return { value: { version: '2.1.290', base: '2.1.290' } };
    });
    on('tool.register', (_$, e) => {
      calls.push(`tool.register ${e.name}`);
      return { value: { tool: `mcp__watchdog__${e.name}` } };
    });
    on('command.register', (_$, e) => {
      calls.push(`command.register ${e.name}`);
      return { value: { command: e.name } };
    });
    on('session.start', (_$, e) => ({ cwd: e.cwd }));
    await $.session.start(START);
    expect(calls).toEqual(['session.version', 'tool.register note', 'command.register watchdog']);
  });

  test('below 2.1.290, session.start registers no note tool', async ($, on: Stubs) => {
    const tools: string[] = [];
    on('session.version', () => ({ value: { version: '2.1.289', base: '2.1.289' } }));
    on('tool.register', (_$, e) => {
      tools.push(e.name);
      return { value: { tool: `mcp__watchdog__${e.name}` } };
    });
    on('command.register', (_$, e) => ({ value: { command: e.name } }));
    on('session.start', (_$, e) => ({ cwd: e.cwd }));
    await $.session.start(START);
    expect(tools).toEqual([]);
  });

  test('a register error writes one log row and the hook still ends', async ($, on: Stubs) => {
    const rows: string[] = [];
    on('session.version', () => ({ value: { version: '2.1.290', base: '2.1.290' } }));
    on('tool.register', (_$, e) => ({ value: { tool: `mcp__watchdog__${e.name}` } }));
    on('command.register', () => ({ deny: 'the name watchdog belongs to another plugin' }));
    on('ui.log', (_$, e) => {
      rows.push(e.text);
      return { value: undefined };
    });
    on('session.start', (_$, e) => ({ cwd: e.cwd }));
    const started = await $.session.start(START);
    expect(started.cwd).toBe('/repo');
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatch(/^\/watchdog is not registered: .*another plugin/u);
  });
});
