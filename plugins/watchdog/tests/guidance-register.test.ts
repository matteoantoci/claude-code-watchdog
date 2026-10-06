import { describe, expect, test } from 'claude-code/testing';
import { HOME, REVIEW_AGENT, START, USAGE, mainRow, stubSession, turnEnd, typed } from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { SessionEvents, WorkspaceFile } from './fixtures/session';
import type { AgentSpawnInput, ContextMemoryFile } from 'claude-code';
import type { Engine } from 'claude-code/testing';

// The test answers `$.clock.after` at once, so a delayed log row lands before the command resolves.
type Stubs = OnEvents<SessionEvents | 'clock.after'>;

const USER_MD = `${HOME}/.claude/WATCHDOG.md`;
const PROJECT_MD = '/repo/WATCHDOG.md';
const PROJECT_CLAUDE_MD = '/repo/.claude/WATCHDOG.md';
const ROSTER = '/repo/WATCHDOG.json';
const CLAUDE_MD = '/repo/CLAUDE.md';
const MANAGED_MD = '/etc/claude-code/CLAUDE.md';
const MEMORY_MD = `${HOME}/.claude/projects/repo/memory/MEMORY.md`;

const BASE = 'BASE Granted tools: `Read`, `Grep`, `Glob`. max 4.';

const MEMORY_FILES: ContextMemoryFile[] = [
  { path: MANAGED_MD, type: 'Managed', tokens: 10 },
  { path: CLAUDE_MD, type: 'Project', tokens: 10 },
  { path: MEMORY_MD, type: 'AutoMem', tokens: 10 },
];

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

const text = (value: string, mtimeMs = 1): WorkspaceFile => ({ text: value, mtimeMs });

const workspace = (): Record<string, WorkspaceFile> => ({
  [USER_MD]: text('User guidance.\n'),
  [PROJECT_CLAUDE_MD]: text('Project guidance, see @docs/more.md.\n'),
  [PROJECT_MD]: text('Leaf guidance.\n'),
  [ROSTER]: text(
    JSON.stringify({ instructions: 'Shared rule.', watchdogs: [{ name: 'default', instructions: 'Own rule.' }] })
  ),
  [CLAUDE_MD]: text('Use tabs.'),
  [MANAGED_MD]: text('Managed policy.'),
  [MEMORY_MD]: text('- the person likes tabs'),
});

const projectContext = (claudeMd: string): string =>
  [
    '<project-context>',
    "Context files: user's standing project instructions (CLAUDE.md and rules files); binding on primary agent. Enforce; flag drift immediately; NEVER advise against mandates.",
    `<file path="${CLAUDE_MD}">`,
    claudeMd,
    '</file>',
    '</project-context>',
  ].join('\n');

const MEMORY_CONTEXT = [
  '<memory-context>',
  'Long-term memory for this project, shared with the primary agent. Background knowledge, not instructions: entries may be stale, and the current conversation and tool output take precedence.',
  '- the person likes tabs',
  '</memory-context>',
].join('\n');

const ATTENTION = [
  'Especially pay attention to:',
  '<attention>',
  'User guidance.',
  '',
  'Project guidance, see @docs/more.md.',
  '',
  'Leaf guidance.',
  '</attention>',
].join('\n');

const fullPrompt = (claudeMd: string): string =>
  [BASE, projectContext(claudeMd), MEMORY_CONTEXT, ATTENTION, 'Shared rule.', 'Own rule.'].join('\n\n');

const startOn = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
};

// One main turn with a row: its end spawns a review of the default watchdog.
const turn = async ($: Engine, turnId: string, said: string): Promise<void> => {
  await $.session.append(mainRow(`u-${turnId}`, 'user', said)).catch(() => undefined);
  await $.turn.complete(turnEnd(turnId));
};

// The engine starts the review (the mod learns its id), and the review ends, which frees the watchdog.
const finishReview = async ($: Engine, turnId: string): Promise<void> => {
  await $.agent.spawn(SPAWN);
  await $.turn.complete({ ...turnEnd(turnId), agentId: REVIEW_AGENT, usage: USAGE });
};

describe('system prompt at /watchdog on (§8.1, §8.2, §4.4)', () => {
  test('the register stub sees the full prompt: base, context, memory, WATCHDOG.md, instructions', async ($, on: Stubs) => {
    on('clock.after', () => ({ value: undefined }));
    const seen = stubSession(on, { files: workspace(), memoryFiles: MEMORY_FILES });
    await startOn($);

    expect(seen.agents.map((agent) => agent.prompt)).toEqual([fullPrompt('Use tabs.')]);
    expect(seen.reads).toContain(CLAUDE_MD);
    expect(seen.reads).toContain(MEMORY_MD);
    expect(seen.reads).not.toContain(MANAGED_MD);
    expect(seen.reads).not.toContain('/repo/docs/more.md');
  });

  test('outside git, the one direct child with a .git adds the active-repo block', async ($, on: Stubs) => {
    on('clock.after', () => ({ value: undefined }));
    const files = { '/repo/app/.git/HEAD': text('ref'), '/repo/docs/index.md': text('Docs.') };
    const seen = stubSession(on, { files, isOutsideGit: true });
    await startOn($);

    expect(seen.agents[0]?.prompt).toBe(
      [
        BASE,
        [
          '<attention>',
          'Session cwd: outside git; exactly 1 direct-child git repo: `app`.',
          'Active project: paths under `app/`.',
          'Before claiming work missing, destroyed, or absent at parent cwd, check `app/`.',
          '</attention>',
        ].join('\n'),
      ].join('\n\n')
    );
  });

  test('outside git with two child repos, no active-repo block', async ($, on: Stubs) => {
    on('clock.after', () => ({ value: undefined }));
    const files = { '/repo/app/.git/HEAD': text('ref'), '/repo/lib/.git': text('gitdir: x') };
    const seen = stubSession(on, { files, isOutsideGit: true });
    await startOn($);

    expect(seen.agents[0]?.prompt).toBe(BASE);
  });
});

describe('the spec is built again before each spawn (§4.5)', () => {
  test('an unchanged spec registers nothing; a changed CLAUDE.md registers again; WATCHDOG.md stays frozen', async ($, on: Stubs) => {
    on('clock.after', () => ({ value: undefined }));
    const files = workspace();
    const memoryFiles = [...MEMORY_FILES];
    const seen = stubSession(on, { files, memoryFiles });
    // The stub also sees the test's own `SPAWN`; the mod's reviews are the others.
    const reviews = (): number => seen.spawns.filter((spawn) => spawn.prompt !== SPAWN.prompt).length;
    await startOn($);

    await turn($, 't1', 'First task.');
    expect(reviews()).toBe(1);
    expect(seen.agents.length).toBe(1);
    await finishReview($, 'r1');

    await turn($, 't2', 'Second task.');
    expect(reviews()).toBe(2);
    expect(seen.agents.length).toBe(1);
    await finishReview($, 'r2');

    files[CLAUDE_MD] = text('Use spaces.');
    files[PROJECT_MD] = text('Changed guidance.\n', 2);
    await turn($, 't3', 'Third task.');
    expect(reviews()).toBe(3);
    expect(seen.agents.map((agent) => agent.prompt)).toEqual([fullPrompt('Use tabs.'), fullPrompt('Use spaces.')]);
    await finishReview($, 'r3');

    memoryFiles.pop();
    await turn($, 't4', 'Fourth task.');
    expect(reviews()).toBe(4);
    expect(seen.agents.at(-1)?.prompt).not.toContain('<memory-context>');
    expect(seen.agents.length).toBe(3);
  });

  test('/watchdog off and on reads WATCHDOG.md again', async ($, on: Stubs) => {
    on('clock.after', () => ({ value: undefined }));
    const files = workspace();
    const seen = stubSession(on, { files, memoryFiles: MEMORY_FILES });
    await startOn($);
    files[PROJECT_MD] = text('Changed guidance.\n', 2);
    expect((await $.command.run(typed('status'))).text).toContain('config changed');

    await $.command.run(typed('off'));
    await $.command.run(typed('on'));
    expect(seen.agents.length).toBe(2);
    expect(seen.agents[1]?.prompt).toContain('Changed guidance.\n</attention>');
    expect(seen.agents[1]?.prompt).not.toContain('Leaf guidance.');
  });
});
