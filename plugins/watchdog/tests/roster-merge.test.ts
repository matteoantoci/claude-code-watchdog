import { describe, expect, test } from 'claude-code/testing';
import { mergeRoster } from '../hooks/roster/merge';
import { parseRosterFile } from '../hooks/roster/parse';

const userFile = (doc: unknown) =>
  parseRosterFile({ label: '~/.claude/WATCHDOG.json', isUser: true, text: JSON.stringify(doc) });
const projectFile = (doc: unknown) =>
  parseRosterFile({ label: './WATCHDOG.json', isUser: false, text: JSON.stringify(doc) });

const slugs = (files: Parameters<typeof mergeRoster>[0]) =>
  mergeRoster(files).watchdogs.map((watchdog) => watchdog.slug);

describe('the roster across files (§4.2)', () => {
  test('no file gives the one default watchdog', () => {
    expect(mergeRoster([]).watchdogs).toEqual([
      expect.objectContaining({ name: 'default', slug: 'default', model: 'opus', effort: 'medium', source: null }),
    ]);
  });

  test('files with only instructions or subagents keep the default watchdog', () => {
    expect(slugs([userFile({ instructions: 'x' }), projectFile({ subagents: { Explore: true } })])).toEqual([
      'default',
    ]);
  });

  test('watchdogs [] gives zero watchdogs', () => {
    expect(slugs([projectFile({ watchdogs: [] })])).toEqual([]);
  });

  test('a watchdogs key with zero valid entries gives zero watchdogs, not the default', () => {
    expect(slugs([projectFile({ watchdogs: [{ name: 3 }] })])).toEqual([]);
  });

  test('the roster is the union of all files; the same slug replaces the earlier entry completely', () => {
    const files = [
      userFile({ watchdogs: [{ name: 'Security', model: 'sonnet', tools: ['WebFetch'] }, { name: 'style' }] }),
      projectFile({ watchdogs: [{ name: 'security', enabled: false }, { name: 'tests' }] }),
    ];
    const roster = mergeRoster(files).watchdogs;
    expect(roster.map((watchdog) => watchdog.slug)).toEqual(['security', 'style', 'tests']);
    expect(roster[0]).toMatchObject({
      name: 'security',
      isEnabled: false,
      model: 'opus',
      tools: ['Read', 'Grep', 'Glob'],
      source: './WATCHDOG.json',
    });
    expect(roster[1]?.source).toBe('~/.claude/WATCHDOG.json');
  });

  test('the same slug inside one file: the later entry wins', () => {
    const roster = mergeRoster([projectFile({ watchdogs: [{ name: 'lint' }, { name: 'Lint', model: 'haiku' }] })]);
    expect(roster.watchdogs.map(({ name, model }) => ({ name, model }))).toEqual([{ name: 'Lint', model: 'haiku' }]);
  });

  test('maxNotesPerReview: the last valid top-level value wins and fills each entry that sets none', () => {
    const files = [
      userFile({ maxNotesPerReview: 6, watchdogs: [{ name: 'a' }, { name: 'b', maxNotesPerReview: 2 }] }),
      projectFile({ maxNotesPerReview: 9 }),
      projectFile({ maxNotesPerReview: 99 }),
    ];
    expect(mergeRoster(files).watchdogs.map((watchdog) => watchdog.maxNotesPerReview)).toEqual([9, 2]);
  });

  test('maxNotesPerReview is 4 when no file sets it', () => {
    expect(mergeRoster([]).watchdogs[0]?.maxNotesPerReview).toBe(4);
  });

  test('instructions of all files join with a blank line, in load order', () => {
    const files = [
      userFile({ instructions: 'Be terse.' }),
      projectFile({}),
      projectFile({ instructions: 'Know the API.' }),
    ];
    expect(mergeRoster(files).instructions).toBe('Be terse.\n\nKnow the API.');
    expect(mergeRoster([]).instructions).toBeNull();
  });

  test('subagents: a later file replaces each key it sets, and false removes the key', () => {
    const files = [
      userFile({ subagents: { Explore: true, Plan: ['a'] } }),
      projectFile({ subagents: { Explore: ['b'], Plan: false } }),
    ];
    expect(mergeRoster(files).subagents).toEqual({ Explore: ['b'] });
  });

  test('the warnings of all files stay in load order', () => {
    const files = [userFile({ colour: 1 }), projectFile({ size: 2 })];
    expect(mergeRoster(files).warnings).toEqual([
      '~/.claude/WATCHDOG.json: unknown key "colour" dropped',
      './WATCHDOG.json: unknown key "size" dropped',
    ]);
  });
});
