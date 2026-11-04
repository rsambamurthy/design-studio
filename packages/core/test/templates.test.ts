import { describe, expect, it } from 'vitest';
import {
  TEMPLATES,
  applyOperation,
  boundaryGaps,
  buildingOuterRect,
  parseOperation,
  runChecks,
  siteChecks,
  type BuildingModel,
} from '../src';

const run = (m: BuildingModel, ...ops: [string, unknown][]) => ops.reduce((acc, [n, a]) => applyOperation(acc, parseOperation(n, a)).model, m);

describe('templates', () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('%s starts with no errors or warnings', (_id, t) => {
    const m = t.build();
    const bad = runChecks(m).filter((i) => i.severity !== 'advisory');
    expect(bad).toEqual([]);
    expect(m.rooms.length).toBeGreaterThanOrEqual(5);
  });

  it('every template has unique ids', () => {
    for (const t of TEMPLATES) {
      const m = t.build();
      const ids = [...m.walls, ...m.rooms, ...m.openings, ...m.furniture].map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('fit_to_buildable', () => {
  const vaidyasSite: [string, unknown][] = [
    ['set_plot', { eastWest: "62'6\"", northSouth: "52'" }],
    ['set_setback', { side: 'all', distance: "5'" }],
    ['set_setback', { side: 'north', distance: "12'" }],
    ['set_access', { side: 'north', kind: 'passage' }],
  ];

  it('makes the 3BHK fill the Vaidyas buildable area exactly, with no setback errors', () => {
    const m = run(TEMPLATES[0]!.build(), ...vaidyasSite, ['fit_to_buildable', {}]);
    const r = buildingOuterRect(m);
    expect(Math.abs(r.x1 - r.x0 - 16002)).toBeLessThanOrEqual(2); // 52'6"
    expect(Math.abs(r.y1 - r.y0 - 10668)).toBeLessThanOrEqual(2); // 35'
    const g = boundaryGaps(m, m.site!);
    expect(Math.abs(g.top - 3658)).toBeLessThanOrEqual(2);
    expect(Math.abs(g.left - 1524)).toBeLessThanOrEqual(2);
    expect(siteChecks(m)).toEqual([]);
    expect(runChecks(m).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('keeps wall thicknesses and door widths', () => {
    const before = TEMPLATES[0]!.build();
    const m = run(before, ...vaidyasSite, ['fit_to_buildable', {}]);
    expect(m.walls.map((w) => w.thickness)).toEqual(before.walls.map((w) => w.thickness));
    expect(m.openings.find((o) => o.id === 'd-main')!.width).toBe(before.openings.find((o) => o.id === 'd-main')!.width);
  });

  it('refuses to stretch a 1BHK across a very large plot', () => {
    expect(() =>
      run(TEMPLATES[2]!.build(), ['set_plot', { eastWest: "150'", northSouth: "100'" }], ['fit_to_buildable', {}]),
    ).toThrow(/too different/);
  });

  it('needs a plot first', () => {
    expect(() => run(TEMPLATES[0]!.build(), ['fit_to_buildable', {}])).toThrow(/plot size first/);
  });
});
