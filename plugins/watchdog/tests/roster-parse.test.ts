import { describe, expect, test } from 'claude-code/testing';
import { parseRosterFile } from '../hooks/roster/parse';

const user = (doc: unknown) => ({ label: '~/.claude/WATCHDOG.json', isUser: true, text: JSON.stringify(doc) });
const project = (doc: unknown) => ({ label: './WATCHDOG.json', isUser: false, text: JSON.stringify(doc) });

const entries = (file: { label: string; isUser: boolean; text: string }) => parseRosterFile(file).watchdogs ?? [];

describe('a WATCHDOG.json entry (§4.2)', () => {
  test('an entry with only a name gets every default', () => {
    expect(entries(project({ watchdogs: [{ name: 'Security Review' }] }))).toEqual([
      {
        name: 'Security Review',
        slug: 'security-review',
        isEnabled: true,
        model: 'opus',
        effort: 'medium',
        noModel: null,
        tools: ['Read', 'Grep', 'Glob'],
        reviewMode: 'turn',
        reviewInterval: 1,
        maxNotesPerReview: undefined,
        instructions: null,
        source: './WATCHDOG.json',
      },
    ]);
  });

  test('every key of an entry is read', () => {
    const doc = {
      watchdogs: [
        {
          name: 'tests',
          enabled: false,
          model: 'sonnet',
          effort: 'high',
          tools: ['Read'],
          reviewMode: 'agent-end',
          reviewInterval: 3,
          maxNotesPerReview: 2,
          instructions: 'Watch the tests.',
        },
      ],
    };
    expect(entries(project(doc))[0]).toMatchObject({
      isEnabled: false,
      model: 'sonnet',
      effort: 'high',
      tools: ['Read'],
      reviewMode: 'agent-end',
      reviewInterval: 3,
      maxNotesPerReview: 2,
      instructions: 'Watch the tests.',
    });
  });

  test('the slug is lowercase, each run of other characters is one dash, and it has at most 64 characters', () => {
    const long = 'Ab'.repeat(40);
    const slugs = entries(project({ watchdogs: [{ name: '  API // Guard!! ' }, { name: long }] })).map(
      (entry) => entry.slug
    );
    expect(slugs).toEqual(['api-guard', 'ab'.repeat(32)]);
  });
});

describe('model and effort of an entry (§6.2)', () => {
  test('the effort key overrides :level, and :level gives the effort when there is no key', () => {
    const doc = {
      watchdogs: [
        { name: 'a', model: 'anthropic/claude-sonnet-4-5:low', effort: 'max' },
        { name: 'b', model: 'opus:auto' },
      ],
    };
    expect(entries(user(doc)).map(({ model, effort }) => ({ model, effort }))).toEqual([
      { model: 'claude-sonnet-4-5', effort: 'max' },
      { model: 'opus', effort: 'auto' },
    ]);
  });

  test('model inherit gives a warning and the default model', () => {
    const parsed = parseRosterFile(project({ watchdogs: [{ name: 'a', model: 'inherit' }] }));
    expect(parsed.watchdogs?.[0]?.model).toBe('opus');
    expect(parsed.warnings).toEqual([
      './WATCHDOG.json: watchdog "a": model "inherit" dropped; the default model applies',
    ]);
  });

  test('another provider keeps the entry with a no_model reason', () => {
    const [entry] = entries(user({ watchdogs: [{ name: 'a', model: 'openai/gpt-5' }] }));
    expect(entry?.noModel).toBe('provider "openai" is not supported; only anthropic works now');
  });
});

describe('tools of an entry (§6.3)', () => {
  test('the user file grants Claude Code tools and MCP tools; a lowercase built-in name counts', () => {
    const doc = { watchdogs: [{ name: 'a', tools: ['read', 'WebFetch', 'mcp__docs__search'] }] };
    expect(entries(user(doc))[0]?.tools).toEqual(['Read', 'WebFetch', 'mcp__docs__search']);
  });

  test('a refused or unknown tool is dropped with a warning, also in the user file', () => {
    const parsed = parseRosterFile(user({ watchdogs: [{ name: 'a', tools: ['Grep', 'bash', 'ToolSearch', 'Frob'] }] }));
    expect(parsed.watchdogs?.[0]?.tools).toEqual(['Grep']);
    expect(parsed.warnings).toEqual([
      '~/.claude/WATCHDOG.json: watchdog "a": tool "Bash" is refused; tool dropped',
      '~/.claude/WATCHDOG.json: watchdog "a": tool "ToolSearch" is refused; tool dropped',
      '~/.claude/WATCHDOG.json: watchdog "a": unknown tool "Frob"; tool dropped',
    ]);
  });

  test('a project file grants only Read, Grep and Glob', () => {
    const parsed = parseRosterFile(
      project({ watchdogs: [{ name: 'a', tools: ['Glob', 'WebFetch', 'mcp__docs__search'] }] })
    );
    expect(parsed.watchdogs?.[0]?.tools).toEqual(['Glob']);
    expect(parsed.warnings).toEqual([
      './WATCHDOG.json: watchdog "a": a project file grants only Read, Grep and Glob; tool "WebFetch" dropped',
      './WATCHDOG.json: watchdog "a": a project file grants only Read, Grep and Glob; tool "mcp__docs__search" dropped',
    ]);
  });

  test('tools [] gives no tools, so the agent has note only', () => {
    expect(entries(project({ watchdogs: [{ name: 'a', tools: [] }] }))[0]?.tools).toEqual([]);
  });
});

describe('bad input (§4.6)', () => {
  test('a file that does not parse is skipped with a warning', () => {
    const parsed = parseRosterFile({ label: './WATCHDOG.json', isUser: false, text: '{ "watchdogs": [' });
    expect(parsed.watchdogs).toBeUndefined();
    expect(parsed.warnings).toEqual([expect.stringMatching(/^\.\/WATCHDOG\.json: not valid JSON; file skipped/u)]);
  });

  test('an unknown key gives a warning and drops only that key', () => {
    const parsed = parseRosterFile(project({ colour: 'red', watchdogs: [{ name: 'a', colour: 'blue' }] }));
    expect(parsed.watchdogs?.map((entry) => entry.slug)).toEqual(['a']);
    expect(parsed.warnings).toEqual([
      './WATCHDOG.json: unknown key "colour" dropped',
      './WATCHDOG.json: watchdog "a": unknown key "colour" dropped',
    ]);
  });

  test('a wrong type on a known key drops the whole entry; the other entries load', () => {
    const doc = {
      watchdogs: [
        { name: 'a', reviewInterval: 0 },
        { name: 'b', tools: 'Read' },
        { name: 'c', maxNotesPerReview: 33 },
        { model: 'opus' },
        'd',
        { name: 'e' },
      ],
    };
    const parsed = parseRosterFile(project(doc));
    expect(parsed.watchdogs?.map((entry) => entry.slug)).toEqual(['e']);
    expect(parsed.warnings).toEqual([
      './WATCHDOG.json: watchdog "a": "reviewInterval" must be an integer of 1 or more; watchdog dropped',
      './WATCHDOG.json: watchdog "b": "tools" must be a list of strings; watchdog dropped',
      './WATCHDOG.json: watchdog "c": "maxNotesPerReview" must be an integer from 1 to 32; watchdog dropped',
      './WATCHDOG.json: watchdog #4: "name" is required; watchdog dropped',
      './WATCHDOG.json: watchdog #5: must be an object; watchdog dropped',
    ]);
  });

  test('a duplicate name in one file gives a warning that names the file and the entry', () => {
    const parsed = parseRosterFile(project({ watchdogs: [{ name: 'Lint' }, { name: 'lint', model: 'haiku' }] }));
    expect(parsed.watchdogs?.map((entry) => entry.model)).toEqual(['opus', 'haiku']);
    expect(parsed.warnings).toEqual([
      './WATCHDOG.json: watchdog "lint": duplicate name in this file; the later entry wins',
    ]);
  });

  test('an invalid top-level maxNotesPerReview gives a warning and is ignored', () => {
    const parsed = parseRosterFile(project({ maxNotesPerReview: 2.5 }));
    expect(parsed.maxNotesPerReview).toBeUndefined();
    expect(parsed.warnings).toEqual([
      './WATCHDOG.json: "maxNotesPerReview" must be an integer from 1 to 32; key dropped',
    ]);
  });

  test('a wrong type on a top-level key drops only that key', () => {
    const parsed = parseRosterFile(
      project({ watchdogs: { name: 'a' }, instructions: 3, subagents: { Explore: 'yes' } })
    );
    expect(parsed.watchdogs).toBeUndefined();
    expect(parsed.instructions).toBeUndefined();
    expect(parsed.subagents).toEqual({});
    expect(parsed.warnings).toEqual([
      './WATCHDOG.json: "watchdogs" must be a list of entries; key dropped',
      './WATCHDOG.json: "instructions" must be a string; key dropped',
      './WATCHDOG.json: subagents "Explore" must be true, false or a list of watchdog slugs; key dropped',
    ]);
  });
});

describe('top-level keys (§4.2)', () => {
  test('instructions, maxNotesPerReview and the subagents map are read', () => {
    const doc = {
      instructions: 'Be terse.',
      maxNotesPerReview: 8,
      subagents: { Explore: true, 'my:coder': ['a'], Plan: false },
    };
    expect(parseRosterFile(project(doc))).toEqual({
      instructions: 'Be terse.',
      maxNotesPerReview: 8,
      watchdogs: undefined,
      subagents: { Explore: true, 'my:coder': ['a'], Plan: false },
      warnings: [],
    });
  });

  test('watchdogs [] is an empty list, not an absent key', () => {
    expect(parseRosterFile(project({ watchdogs: [] })).watchdogs).toEqual([]);
  });
});
