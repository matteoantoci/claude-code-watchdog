import { describe, expect, test } from 'claude-code/testing';
import { addStatusLines, statusText } from '../hooks/command/status';

describe('status text', () => {
  test('lines that areas add follow the first line, in the order they were added', () => {
    addStatusLines(() => ['reviews 2']);
    addStatusLines(() => []);
    addStatusLines(() => ['warning: bad immuneTurns', 'last error: none']);
    expect(statusText('watchdog on')).toBe('watchdog on\nreviews 2\nwarning: bad immuneTurns\nlast error: none');
  });
});
