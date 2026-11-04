import { describe, expect, it } from 'vitest';
import { formatFtIn, parseLength } from '../src';

describe('parseLength', () => {
  it.each([
    ['8"', 203],
    ['8 in', 203],
    ['8 inches', 203],
    ["1'6\"", 457],
    ["1' 6\"", 457],
    ["5'-0\"", 1524],
    ['1 ft 6 in', 457],
    ['1 feet 6 inches', 457],
    ['1.5 ft', 457],
    ['10 1/2"', 267],
    ["2'6 1/2\"", 775],
    ['450mm', 450],
    ['45 cm', 450],
    ['0.45 m', 450],
    ["3′6″", 1067],
  ])('%s -> %i mm', (text, mm) => {
    const p = parseLength(text);
    expect(p.mm).toBe(mm);
    expect(p.assumedUnit).toBe(false);
  });

  it('flags bare numbers as assumed feet', () => {
    const p = parseLength('3');
    expect(p.mm).toBe(914);
    expect(p.assumedUnit).toBe(true);
    expect(p.note).toMatch(/assumed feet/);
  });

  it('rejects nonsense', () => {
    expect(() => parseLength('a bit')).toThrow(/Could not read/);
  });
});

describe('formatFtIn', () => {
  it.each([
    [203.2, '8"'],
    [711.2, "2'4\""],
    [3048, "10'0\""],
    [146.05, '5¾"'],
    [304.8 * 11 + 25.4 * 11.9, "12'0\""],
  ])('%f mm -> %s', (mm, text) => {
    expect(formatFtIn(mm)).toBe(text);
  });
});
