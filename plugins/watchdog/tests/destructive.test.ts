import { describe, expect, test } from 'claude-code/testing';
import { isUnsafeNote } from '../hooks/note/destructive';

describe('destructive-command check', () => {
  test('a note with `rm` and both `-r` and `-f` flags, in any order or case, is unsafe when the batch has none', () => {
    for (const note of ['Run rm -rf build/ first.', 'rm -fr dist', 'RM -R -F /tmp/x', 'try rm -f -r node_modules']) {
      expect(isUnsafeNote(note, 'assistant: I will rebuild the project.')).toBe(true);
    }
  });

  test('a note without the pattern is safe', () => {
    for (const note of [
      'rm -r build',
      'rm -f lock',
      'Use git rm --cached file',
      'perform -rf',
      'Missing null check.',
    ]) {
      expect(isUnsafeNote(note, '')).toBe(false);
    }
  });

  test('the note is safe when the batch the review got holds the pattern too', () => {
    expect(isUnsafeNote('Do not run rm -rf build again.', 'tool Bash: rm -Rf build && npm run build')).toBe(false);
  });
});
