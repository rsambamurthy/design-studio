import { describe, expect, it } from 'vitest';
import {
  TEMPLATES,
  boundaryGaps,
  buildingOuterRect,
  chooseLayout,
  parseOperation,
  rotateLayout,
  runChecks,
  siteChecks,
  startDesign,
  roomClearRect,
  L,
} from '../src';

const ops = (...xs: [string, unknown][]) => xs.map(([n, a]) => parseOperation(n, a));
const plotOps = (ew: string, ns: string, setback = "5'") =>
  ops(['set_plot', { eastWest: ew, northSouth: ns }], ['set_setback', { side: 'all', distance: setback }]);

describe('rotateLayout', () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('%s turned 90° stays valid and swaps width/depth', (_id, t) => {
    const m = t.build();
    const r = rotateLayout(m);
    const a = buildingOuterRect(m);
    const b = buildingOuterRect(r);
    expect(Math.round(b.x1 - b.x0)).toBe(Math.round(a.y1 - a.y0));
    expect(Math.round(b.y1 - b.y0)).toBe(Math.round(a.x1 - a.x0));
    expect(runChecks(r).filter((i) => i.severity !== 'advisory')).toEqual([]);
    for (const room of r.rooms) {
      const c = roomClearRect(r, room);
      expect(c.x1).toBeGreaterThan(c.x0);
      expect(c.y1).toBeGreaterThan(c.y0);
    }
  });
});

describe('chooseLayout', () => {
  it('600 sq ft plinth gets a 1BHK', () => {
    expect(chooseLayout(L("30'"), L("20'")).templateId).toBe('1bhk');
  });
  it('1,500 sq ft plinth gets a 3BHK', () => {
    expect(chooseLayout(L("50'"), L("30'")).templateId).toBe('3bhk');
  });
  it('a deep, narrow plinth gets a turned layout', () => {
    const c = chooseLayout(L("20'"), L("40'"));
    expect(c.rotated).toBe(true);
  });
  it('a tiny plinth is refused with a reason', () => {
    expect(() => chooseLayout(L("8'"), L("6'"))).toThrow(/No standard layout suits/);
  });
});

describe('startDesign (best fit)', () => {
  it("40' × 30' plot with 5' setbacks: layout fills the 30' × 20' plinth exactly", () => {
    const { model, notes } = startDesign('auto', plotOps("40'", "30'"), 'Test');
    const r = buildingOuterRect(model);
    expect(Math.abs(r.x1 - r.x0 - L("30'"))).toBeLessThanOrEqual(2);
    expect(Math.abs(r.y1 - r.y0 - L("20'"))).toBeLessThanOrEqual(2);
    const g = boundaryGaps(model, model.site!);
    for (const side of ['top', 'bottom', 'left', 'right'] as const) expect(Math.abs(g[side] - L("5'"))).toBeLessThanOrEqual(2);
    expect(siteChecks(model)).toEqual([]);
    expect(runChecks(model).filter((i) => i.severity === 'error')).toEqual([]);
    expect(notes.join(' ')).toMatch(/1BHK flat, chosen for a 600 sq ft plinth/);
  });

  it("60' × 40' default plot gives a 3BHK on a 50' × 30' plinth", () => {
    const { model, notes } = startDesign('auto', plotOps("60'", "40'"), 'Test');
    const r = buildingOuterRect(model);
    expect(Math.abs(r.x1 - r.x0 - L("50'"))).toBeLessThanOrEqual(2);
    expect(Math.abs(r.y1 - r.y0 - L("30'"))).toBeLessThanOrEqual(2);
    expect(notes[0]).toMatch(/3BHK/);
    expect(siteChecks(model)).toEqual([]);
  });

  it('a narrow, deep plot gets a turned layout that fits', () => {
    const { model, notes } = startDesign('auto', plotOps("30'", "60'"), 'Test');
    const r = buildingOuterRect(model);
    expect(Math.abs(r.x1 - r.x0 - L("20'"))).toBeLessThanOrEqual(2);
    expect(Math.abs(r.y1 - r.y0 - L("50'"))).toBeLessThanOrEqual(2);
    expect(notes[0]).toMatch(/turned 90°/);
    expect(runChecks(model).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('a chosen layout is sized to the plinth too', () => {
    const { model } = startDesign('2bhk', plotOps("40'", "30'"), 'Test');
    const r = buildingOuterRect(model);
    expect(Math.abs(r.x1 - r.x0 - L("30'"))).toBeLessThanOrEqual(2);
    expect(model.rooms.some((x) => x.name === 'Bed 2')).toBe(true);
  });

  it('setbacks that leave no room are refused', () => {
    expect(() => startDesign('auto', plotOps("20'", "20'", "10'"), 'Test')).toThrow(/no room to build/);
  });

  it('without a plot, a chosen layout starts at its default size', () => {
    const { model } = startDesign('2bhk', [], 'Test');
    expect(model.site).toBeUndefined();
    expect(() => startDesign('auto', [], 'Test')).toThrow(/Enter the plot size/);
  });
});
