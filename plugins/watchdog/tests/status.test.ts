import { describe, expect, test } from 'claude-code/testing';
import { addStatusHead, addStatusLines, statusText } from '../hooks/command/status';

describe('status text', () => {
  test('lines that areas add follow the first line, in the order they were added', () => {
    addStatusLines(() => ['reviews 2']);
    addStatusLines(() => []);
    addStatusLines(() => ['warning: bad immuneTurns', 'last error: none']);
    expect(statusText('watchdog on')).toBe('watchdog on\nreviews 2\nwarning: bad immuneTurns\nlast error: none');
  });

  test('parts that areas add join the first line with " · ", in the order they were added', () => {
    addStatusHead(() => ['nudge 1/1', 'cooldown 3']);
    addStatusHead(() => []);
    addStatusHead(() => ['12.8k tok']);
    expect(statusText('watchdog on').split('\n')[0]).toBe('watchdog on · nudge 1/1 · cooldown 3 · 12.8k tok');
  });
});
