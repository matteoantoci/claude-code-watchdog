import { describe, expect, test } from 'claude-code/testing';
import { fitBand, wrappedRows } from '../hooks/band/fit';

// A full band of 3 cards and `+N more`: the count line, 3 headers and `+N more` are 5 rows, 3 gaps between
// the 4 items, and 3 bodies of 3 rows each: 17 rows.
const BAND = { bodies: [3, 3, 3], lines: 5, gaps: 3 };

describe('band row estimate (§13.1)', () => {
  test('a line wraps at word ends; each line break starts a row', () => {
    expect(wrappedRows('one two three', 13)).toBe(1);
    expect(wrappedRows('one two three', 12)).toBe(2);
    expect(wrappedRows('one two\n- three\n- four', 20)).toBe(3);
  });

  test('a word wider than the row breaks across rows; the text is trimmed first, and code ticks draw no cell', () => {
    expect(wrappedRows('abcdefghij', 4)).toBe(3);
    expect(wrappedRows('ab abcdefghij', 4)).toBe(4);
    expect(wrappedRows('\none\n', 10)).toBe(1);
    expect(wrappedRows('`price - percent`', 15)).toBe(1);
  });
});

describe('band fit (§13.1)', () => {
  test('a band within maxRows, or with no maxRows, keeps every body whole and the blank rows', () => {
    const whole = { cut: [false, false, false], hasGaps: true };
    expect(fitBand(BAND, 17)).toEqual(whole);
    expect(fitBand(BAND, undefined)).toEqual(whole);
  });

  test('a taller band cuts the last card first, then the card above it', () => {
    expect(fitBand(BAND, 16)).toEqual({ cut: [false, false, true], hasGaps: true });
    expect(fitBand(BAND, 14)).toEqual({ cut: [false, true, true], hasGaps: true });
  });

  test('a body of one row is not cut: the cut goes on to the card above', () => {
    expect(fitBand({ ...BAND, bodies: [3, 3, 1] }, 14)).toEqual({ cut: [false, true, false], hasGaps: true });
  });

  test('the blank rows go next; the top card is never cut', () => {
    expect(fitBand(BAND, 12)).toEqual({ cut: [false, true, true], hasGaps: false });
    expect(fitBand(BAND, 1)).toEqual({ cut: [false, true, true], hasGaps: false });
    expect(fitBand({ bodies: [9], lines: 2, gaps: 0 }, 3)).toEqual({ cut: [false], hasGaps: false });
  });
});
