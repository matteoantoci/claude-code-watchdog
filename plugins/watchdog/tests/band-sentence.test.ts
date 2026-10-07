import { describe, expect, test } from 'claude-code/testing';
import { firstSentence } from '../hooks/band/tree';

describe('the first sentence of a collapsed card (§13.1)', () => {
  test('a sentence ends at the first `.`, `?` or `!` that a space follows', () => {
    expect(firstSentence('The migration drops users. The copy runs after it.')).toBe('The migration drops users.');
    expect(firstSentence('Is the lock released? The finally block returns early.')).toBe('Is the lock released?');
    expect(firstSentence('Stop! The deploy script wipes prod.')).toBe('Stop!');
  });

  test('a period inside a file reference ends nothing', () => {
    expect(firstSentence('cart.py:3 rounds the tax twice. The total is off by a cent.')).toBe(
      'cart.py:3 rounds the tax twice.'
    );
  });

  test('a text with no sentence end is whole, a final period kept', () => {
    expect(firstSentence('parseDate drops the timezone; date.spec.ts:40 passes only in UTC')).toBe(
      'parseDate drops the timezone; date.spec.ts:40 passes only in UTC'
    );
    expect(firstSentence('The regex accepts expired tokens.')).toBe('The regex accepts expired tokens.');
  });

  test('a code span ends nothing and loses its ticks', () => {
    expect(firstSentence('`price.toFixed(2)` rounds twice. Round once.')).toBe('price.toFixed(2) rounds twice.');
    expect(firstSentence('Run `make test. lint` before you push. CI runs both.')).toBe(
      'Run make test. lint before you push.'
    );
  });

  test('a line break ends the sentence: a listed note shows its first line', () => {
    expect(firstSentence('\nThe /export route is open\n- it skips `requireAuth`\n- every other route has it')).toBe(
      'The /export route is open'
    );
  });
});
