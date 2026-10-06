import { describe, expect, test } from 'claude-code/testing';
import { stubState } from './fixtures/on-state';
import { REVIEW_AGENT, START, stubSession, typed } from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { StateStubs } from './fixtures/on-state';
import type { SessionEvents } from './fixtures/session';
import type { AgentSpawnInput, ToolCallArgs, ToolCheckDecision } from 'claude-code';
import type { Engine } from 'claude-code/testing';

type Stubs = OnEvents<SessionEvents | 'tool.check'>;

type ReloadStubs = Stubs & StateStubs;

// A subagent of the primary agent: not in the watchdog id set.
const SUBAGENT = 'asub0001';

const SPAWN: AgentSpawnInput = {
  tool_use_id: 'toolu_plugin_00000000000000000000000000000001',
  prompt: 'review',
  description: 'watchdog default review',
  subagentType: 'watchdog:default',
  provider: { plugin: 'watchdog', tier: 'user' },
  parentModel: 'claude-opus-4-5',
  background: true,
  fork: false,
};

// The engine passes a subagent's `agentId` on to the hooks, and so does the kit; `$.tool.call` does not type it.
const inLoop = (agentId: string, call: { readonly tool: string; readonly [argument: string]: unknown }): ToolCallArgs =>
  ({ ...call, agentId }) as ToolCallArgs;

const fileOf = (input: unknown): string =>
  typeof input === 'object' && input !== null && 'file_path' in input ? String(input.file_path) : '';

// The engine's verdict: the cwd `/repo` is allowed, `/etc/shadow` denied by a rule, every other path asks.
const engineVerdict = (input: unknown): ToolCheckDecision => {
  const file = fileOf(input);
  if (file.startsWith('/repo/')) {
    return 'allow';
  }
  return file === '/etc/shadow' ? 'deny' : 'ask';
};

const stub = (on: Stubs) => {
  const checks: string[] = [];
  // Core answers a read of a missing file with an error.
  on('tool.call', { file_path: '/outside/missing.ts' }, () => ({ isError: true, result: 'File does not exist.' }));
  on('tool.check', (_$, e) => {
    checks.push(fileOf(e.input));
    const decision = engineVerdict(e.input);
    return decision === 'deny'
      ? { decision, reason: 'Read(/etc/shadow) is denied', rule: 'Read(/etc/shadow)' }
      : { decision };
  });
  return { seen: stubSession(on), checks };
};

const startReview = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await $.agent.spawn(SPAWN);
};

const reviewRead = async ($: Engine, file: string) =>
  $.tool.check({ tool: 'Read', input: { file_path: file }, agentId: REVIEW_AGENT, tool_use_id: 'toolu_check' });

describe('the mutating-tool guard', () => {
  test('a review agent runs only its tools, and a denied call never reaches core', async ($, on: Stubs) => {
    const { seen } = stub(on);
    await startReview($);
    const bash = await $.tool.call(inLoop(REVIEW_AGENT, { tool: 'Bash', command: 'rm -rf build' }));
    const edit = await $.tool.call(
      inLoop(REVIEW_AGENT, { tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })
    );
    const agent = await $.tool.call(
      inLoop(REVIEW_AGENT, { tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'Explore' })
    );
    const read = await $.tool.call(inLoop(REVIEW_AGENT, { tool: 'Read', file_path: '/repo/a.ts' }));

    expect(bash).toEqual({ deny: "A watchdog cannot run Bash: it is not in this watchdog's tools." });
    expect(edit).toEqual({ deny: "A watchdog cannot run Edit: it is not in this watchdog's tools." });
    expect(agent).toEqual({ deny: "A watchdog cannot run Agent: it is not in this watchdog's tools." });
    expect(read).toEqual({ result: 'core' });
    expect(seen.coreToolCalls).toEqual(['Read']);
  });

  test('a subagent of the primary agent runs any tool', async ($, on: Stubs) => {
    const { seen } = stub(on);
    await startReview($);
    const bash = await $.tool.call(inLoop(SUBAGENT, { tool: 'Bash', command: 'npm test' }));
    expect(bash).toEqual({ result: 'core' });
    expect(seen.coreToolCalls).toEqual(['Bash']);
  });
});

// The kit gives the `watchdog` origin only to the mod's own `$` calls: a stub may not call `$`, and an
// inline plugin may not be named `watchdog`. A fork's deny is in tests/read-scope.test.ts (`guardDeny`);
// here, the deny keys on that origin, not on an unknown `agentId` alone.
describe('the fork deny', () => {
  test('an unknown agentId from the engine passes', async ($, on: Stubs) => {
    const { seen } = stub(on);
    await startReview($);
    const read = await $.tool.call(inLoop('afork0001', { tool: 'Read', file_path: '/repo/a.ts' }));
    expect(read).toEqual({ result: 'core' });
    expect(seen.coreToolCalls).toEqual(['Read']);
  });

  test(
    'an unknown agentId from another plugin passes',
    {
      plugins: [
        {
          name: 'other',
          register(on: OnEvents<'command.run'>) {
            on('command.run', { command: 'other' }, async ($) => {
              const call = { tool: 'Read', agentId: 'afork0001', file_path: '/repo/a.ts' } as ToolCallArgs;
              const answer = await $.tool.call(call);
              return { text: JSON.stringify(answer) };
            });
          },
        },
      ],
    },
    async ($, on: Stubs) => {
      stub(on);
      await startReview($);
      const answer = await $.command.run({ ...typed(''), command: 'other' });
      expect(answer.text).toBe(JSON.stringify({ result: 'core' }));
    }
  );
});

describe('the read scope', () => {
  test('an ask becomes allow only for a read the primary agent or a subagent made without error', async ($, on: Stubs) => {
    stub(on);
    await startReview($);
    await $.tool.call({ tool: 'Read', file_path: '/outside/lib/a.ts' });
    await $.tool.call({ tool: 'Read', file_path: '/outside/missing.ts' });
    await $.tool.call(inLoop(SUBAGENT, { tool: 'Grep', pattern: 'TODO', path: '/outside/lib' }));
    await $.tool.call(inLoop(REVIEW_AGENT, { tool: 'Read', file_path: '/outside/own.ts' }));

    expect(await reviewRead($, '/outside/x/../lib/a.ts')).toEqual({ decision: 'allow' });
    const grep = { tool: 'Grep', input: { path: '/outside/./lib/', pattern: 'TODO' }, agentId: REVIEW_AGENT };
    expect(await $.tool.check(grep)).toEqual({ decision: 'allow' });
    expect(await reviewRead($, '/outside/missing.ts')).toEqual({
      decision: 'deny',
      reason:
        'Outside the watchdog read scope: /outside/missing.ts. Do not retry this path. Review with what you have.',
    });
    expect((await reviewRead($, '/outside/own.ts')).decision).toBe('deny');
    expect((await reviewRead($, '/outside/lib/b.ts')).decision).toBe('deny');
    const otherGrep = { tool: 'Grep', input: { path: '/outside/lib', pattern: 'FIXME' }, agentId: REVIEW_AGENT };
    expect((await $.tool.check(otherGrep)).decision).toBe('deny');
  });

  test('an engine allow and an engine deny stand, and a path above `/` is denied', async ($, on: Stubs) => {
    stub(on);
    await startReview($);
    await $.tool.call({ tool: 'Read', file_path: '/etc/passwd' });

    expect(await reviewRead($, '/repo/a.ts')).toEqual({ decision: 'allow' });
    expect(await reviewRead($, '/etc/shadow')).toEqual({
      decision: 'deny',
      reason: 'Read(/etc/shadow) is denied',
      rule: 'Read(/etc/shadow)',
    });
    expect(await reviewRead($, '/etc/passwd')).toEqual({ decision: 'allow' });
    expect((await reviewRead($, '/../etc/passwd')).decision).toBe('deny');
  });

  test('a check of the primary agent or of a subagent keeps the engine ask', async ($, on: Stubs) => {
    stub(on);
    await startReview($);
    const main = await $.tool.check({ tool: 'Read', input: { file_path: '/outside/z.ts' }, tool_use_id: 'toolu_main' });
    const sub = await $.tool.check({ tool: 'Read', input: { file_path: '/outside/z.ts' }, agentId: SUBAGENT });
    expect(main).toEqual({ decision: 'ask' });
    expect(sub).toEqual({ decision: 'ask' });
  });

  test('/watchdog status shows the read-scope deny count of each watchdog', async ($, on: Stubs) => {
    stub(on);
    await startReview($);
    const before = await $.command.run(typed('status'));
    await reviewRead($, '/outside/a.ts');
    await reviewRead($, '/outside/b.ts');
    await reviewRead($, '/repo/a.ts');
    const after = await $.command.run(typed('status'));

    expect(before.text).not.toMatch(/read-scope denies/u);
    expect(after.text?.split('\n')).toContain('default read-scope denies: 2');
  });

  test('after a reload the status shows the deny counts $.state kept, before any read or check', async ($, on: ReloadStubs) => {
    stub(on);
    stubState(on, { state: { isOn: true, source: '/watchdog on' }, values: new Map([['denies', { default: 2 }]]) });
    await $.session.start(START);
    expect((await $.command.run(typed('status'))).text?.split('\n')).toContain('default read-scope denies: 2');
  });
});
