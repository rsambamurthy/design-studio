import { describe, expect, it } from 'vitest';
import {
  applyOperation,
  boundaryGaps,
  modelSummary,
  parseOperation,
  runChecks,
  sampleModel,
  siteChecks,
  type BuildingModel,
} from '../src';

const op = (name: string, args: unknown) => parseOperation(name, args);
const run = (m: BuildingModel, ...ops: [string, unknown][]) => ops.reduce((acc, [n, a]) => applyOperation(acc, op(n, a)).model, m);
const codes = (m: BuildingModel) => siteChecks(m).map((i) => i.code);

/** The Vaidyas plot as described: 62'6" E–W × 52' N–S, 12' north passage, 5' elsewhere, two trees. */
function vaidyas(m = sampleModel()) {
  return run(
    m,
    ['set_plot', { eastWest: "62'6\"", northSouth: "52'" }],
    ['set_setback', { side: 'all', distance: "5'" }],
    ['set_setback', { side: 'north', distance: "12'" }],
    ['set_access', { side: 'north', kind: 'passage' }],
    ['add_tree', { label: 'Mango tree', position: 'north-west corner' }],
    ['add_tree', { label: 'Neem tree', position: 'west side' }],
  );
}

describe('site: plot and setbacks', () => {
  it('needs a plot before setbacks', () => {
    expect(() => applyOperation(sampleModel(), op('set_setback', { side: 'north', distance: "12'" }))).toThrow(/Set the plot size first/);
  });

  it('creates the site and centres the building', () => {
    const r = applyOperation(sampleModel(), op('set_plot', { eastWest: "62'6\"", northSouth: "52'" }));
    const site = r.model.site!;
    expect(site.plot).toEqual({ width: 19050, depth: 15850 });
    const g = boundaryGaps(r.model, site);
    expect(Math.abs(g.left - g.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.top - g.bottom)).toBeLessThanOrEqual(1);
    expect(r.summary).toBe('Plot set to 62\'6" (E–W) × 52\'0" (N–S).');
  });

  it('maps east–west to the plan axis that the north arrow says', () => {
    const turned = { ...sampleModel(), northAngle: 90 }; // north points plan-right
    const r = applyOperation(turned, op('set_plot', { eastWest: "62'6\"", northSouth: "52'" }));
    expect(r.model.site!.plot).toEqual({ width: 15850, depth: 19050 });
    const s = applyOperation(r.model, op('set_setback', { side: 'north', distance: "12'" })).model.site!;
    expect(s.setbacks.right).toBe(3658);
  });

  it('records the passage width from the setback when not given', () => {
    const m = vaidyas();
    expect(m.site!.access).toEqual([{ side: 'top', kind: 'passage', width: 3658 }]);
    expect(m.site!.setbacks).toEqual({ top: 3658, bottom: 1524, left: 1524, right: 1524 });
  });

  it('places named trees inside the plot', () => {
    const m = vaidyas();
    const [mango, neem] = m.site!.trees;
    expect(mango!.at).toEqual({ x: 1219, y: 1219 });
    expect(neem!.at).toEqual({ x: 1219, y: 7925 });
  });

  it('flags the sample flat as too big for the Vaidyas buildable area', () => {
    // The sample is 52'6" × 35' wall-centre to wall-centre with 9" outer walls, so its
    // outer faces measure 53'3" × 35'9": wider and deeper than 52'6" × 35' between setbacks.
    const issues = siteChecks(vaidyas());
    expect(issues.filter((i) => i.code === 'site.setback').length).toBeGreaterThanOrEqual(2);
    expect(issues.find((i) => i.code === 'site.setback')!.message).toMatch(/required/);
  });

  it('a building that fits, pushed to the north-west setback lines, is clean', () => {
    const big = run(sampleModel(), ['set_plot', { eastWest: "70'", northSouth: "60'" }]);
    const m = run(
      big,
      ['set_setback', { side: 'all', distance: "5'" }],
      ['set_setback', { side: 'north', distance: "12'" }],
      ['set_access', { side: 'north', kind: 'passage' }],
      ['add_tree', { label: 'Mango tree', position: 'north-west corner' }],
      ['place_building', { northSouth: 'north', eastWest: 'west' }],
    );
    const g = boundaryGaps(m, m.site!);
    expect(Math.abs(g.top - 3658)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.left - 1524)).toBeLessThanOrEqual(1);
    expect(codes(m).filter((c) => c !== 'site.tree-canopy')).toEqual([]);
    expect(codes(m)).toContain('site.tree-canopy');
  });

  it('moving the building into the passage breaks the setback and the passage', () => {
    const big = run(
      sampleModel(),
      ['set_plot', { eastWest: "70'", northSouth: "60'" }],
      ['set_setback', { side: 'north', distance: "12'" }],
      ['set_access', { side: 'north', kind: 'passage' }],
      ['place_building', { northSouth: 'north', eastWest: 'centre' }],
      ['move_building', { direction: 'north', distance: "2'" }],
    );
    expect(codes(big)).toEqual(expect.arrayContaining(['site.setback', 'site.access-blocked']));
    expect(runChecks(big).some((i) => i.space === 'site')).toBe(true);
  });

  it('a kept tree inside the building is an error', () => {
    const m = run(sampleModel(), ['set_plot', { eastWest: "62'6\"", northSouth: "52'" }], ['add_tree', { label: 'Coconut', position: 'centre' }]);
    expect(codes(m)).toContain('site.tree-conflict');
  });

  it('tells the assistant about the site', () => {
    const s = modelSummary(vaidyas());
    expect(s).toMatch(/SITE: plot 62'6" E–W × 52'0" N–S/);
    expect(s).toMatch(/passage on north, 12'0"/);
    expect(s).toMatch(/tree-1: Mango tree \(keep\)/);
  });
});
