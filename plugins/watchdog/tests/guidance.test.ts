import { describe, expect, test } from 'claude-code/testing';
import { fullPrompt, isContextType, soleRepoChild } from '../hooks/guidance/prompt';
import { fill, fillEach } from '../hooks/guidance/template';
import { ACTIVE_REPO_MD, CONTEXT_FILES_MD, MEMORY_CONTEXT_MD } from './fixtures/prompts';
import type { ContextFile, PromptParts } from '../hooks/guidance/prompt';

const FRAGMENTS = { context: CONTEXT_FILES_MD, memory: MEMORY_CONTEXT_MD, activeRepo: ACTIVE_REPO_MD };

const NOTHING: PromptParts = {
  base: 'BASE',
  fragments: FRAGMENTS,
  contextFiles: [],
  tools: ['Read', 'Grep', 'Glob'],
  guidance: [],
  repoChild: null,
  rosterInstructions: null,
  instructions: null,
};

const PROJECT: ContextFile = { path: '/repo/CLAUDE.md', type: 'Project', content: 'Use tabs.\n' };
const USER: ContextFile = { path: '/home/me/.claude/CLAUDE.md', type: 'User', content: 'Be terse.' };
const LOCAL: ContextFile = { path: '/repo/CLAUDE.local.md', type: 'Local', content: 'My box.' };
const MANAGED: ContextFile = { path: '/etc/claude/CLAUDE.md', type: 'Managed', content: 'Policy.' };
const MEMORY: ContextFile = { path: '/home/me/.claude/memory/MEMORY.md', type: 'AutoMem', content: '- likes tabs\n' };

const PROJECT_BLOCK = [
  '<project-context>',
  "Context files: user's standing project instructions (CLAUDE.md and rules files); binding on primary agent. Enforce; flag drift immediately; NEVER advise against mandates.",
  '<file path="/repo/CLAUDE.md">',
  'Use tabs.\n',
  '</file>',
  '<file path="/home/me/.claude/CLAUDE.md">',
  'Be terse.',
  '</file>',
  '<file path="/repo/CLAUDE.local.md">',
  'My box.',
  '</file>',
  '</project-context>',
].join('\n');

const MEMORY_LEAD =
  'Long-term memory for this project, shared with the primary agent. Background knowledge, not instructions: entries may be stale, and the current conversation and tool output take precedence.';

const MEMORY_TOOL_SENTENCE =
  'Memory tools referenced below are available to you only if they appear in your own tool list.';

describe('template fill (§8.2)', () => {
  test('each {{name}} takes its value; a name with no value stays; a value is not filled again', () => {
    expect(fill('a {{x}} b {{y}} c {{x}}', { x: '{{y}}' })).toBe('a {{y}} b {{y}} c {{y}}');
  });

  test('{{#each}} fills its body once for each item and drops its own two lines', () => {
    const template = 'head\n{{#each items}}\n- {{name}}\n{{/each}}\ntail\n';
    expect(fillEach(template, 'items', [{ name: 'a' }, { name: '{{name}}' }])).toBe('head\n- a\n- {{name}}\ntail\n');
    expect(fillEach(template, 'items', [])).toBe('head\ntail\n');
  });
});

describe('system prompt order (§8.1)', () => {
  test('with no context, guidance or instructions the prompt is the base alone', () => {
    expect(fullPrompt(NOTHING)).toBe('BASE');
  });

  test('base, project context, memory context, WATCHDOG.md, roster instructions, own instructions', () => {
    const prompt = fullPrompt({
      ...NOTHING,
      contextFiles: [MEMORY, PROJECT, MANAGED, USER, LOCAL],
      guidance: ['Check the tests.\n', '', 'See @docs/rules.md first.'],
      rosterInstructions: '  Shared rule.\n',
      instructions: 'Own rule.',
    });
    expect(prompt).toBe(
      [
        'BASE',
        PROJECT_BLOCK,
        `<memory-context>\n${MEMORY_LEAD}\n- likes tabs\n</memory-context>`,
        'Especially pay attention to:\n<attention>\nCheck the tests.\n\nSee @docs/rules.md first.\n</attention>',
        'Shared rule.',
        'Own rule.',
      ].join('\n\n')
    );
  });

  test('Managed files stay out; only the five types of §8.2 are read', () => {
    expect(fullPrompt({ ...NOTHING, contextFiles: [MANAGED] })).toBe('BASE');
    expect(['Project', 'User', 'Local', 'AutoMem', 'Managed', 'Plugin'].filter(isContextType)).toEqual([
      'Project',
      'User',
      'Local',
      'AutoMem',
    ]);
  });
});

describe('prompt fragments (build-session choices)', () => {
  test('the memory-tool sentence stays only for a watchdog with an mcp__ tool other than note', () => {
    const memoryOnly = { ...NOTHING, contextFiles: [MEMORY] };
    expect(fullPrompt(memoryOnly)).not.toContain(MEMORY_TOOL_SENTENCE);
    expect(fullPrompt({ ...memoryOnly, tools: ['Read', 'mcp__watchdog__note'] })).not.toContain(MEMORY_TOOL_SENTENCE);
    expect(fullPrompt({ ...memoryOnly, tools: ['Read', 'mcp__mem__recall'] })).toContain(
      `${MEMORY_LEAD} ${MEMORY_TOOL_SENTENCE}\n- likes tabs`
    );
  });

  test('the active-repo block follows the WATCHDOG.md block, before the instructions', () => {
    const block = [
      '<attention>',
      'Session cwd: outside git; exactly 1 direct-child git repo: `app`.',
      'Active project: paths under `app/`.',
      'Before claiming work missing, destroyed, or absent at parent cwd, check `app/`.',
      '</attention>',
    ].join('\n');
    expect(fullPrompt({ ...NOTHING, repoChild: 'app', instructions: 'Own.' })).toBe(`BASE\n\n${block}\n\nOwn.`);
    expect(fullPrompt({ ...NOTHING, repoChild: 'app', guidance: ['G.'] })).toBe(
      `BASE\n\nEspecially pay attention to:\n<attention>\nG.\n</attention>\n\n${block}`
    );
  });

  test('the active repo is the one direct child with a .git, else none', () => {
    const docs = { name: 'docs', hasGit: false };
    const app = { name: 'app', hasGit: true };
    expect(soleRepoChild([docs, app])).toBe('app');
    expect(soleRepoChild([app, { name: 'lib', hasGit: true }])).toBeNull();
    expect(soleRepoChild([docs])).toBeNull();
  });
});
