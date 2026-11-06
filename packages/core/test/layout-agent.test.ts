import { describe, expect, it } from 'vitest';
import { allRulesDecider, applyOperation, briefObjective, checkBrief, parseOperation, runChecks, runFixLoop, startDesign, type BuildingModel } from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);
const apply = (m: BuildingModel, n: string, a: unknown) => applyOperation(m, op(n, a)).model;
const shell = (ew = "60'", ns = "40'") => startDesign('shell', [op('set_plot', { eastWest: ew, northSouth: ns }), op('set_setback', { side: 'all', distance: "5'" })], 'T').model;

const layoutBrief = (bed: number, toilets: number) => [
  { type: 'count', rooms: 'bedrooms', n: bed },
  { type: 'count', rooms: 'toilets', n: toilets },
  { type: 'count', rooms: 'kitchen', n: 1 },
  { type: 'count', rooms: 'pooja', n: 1 },
  { type: 'outer_wall', rooms: 'bedrooms' },
  { type: 'window', rooms: 'bedrooms' },
  { type: 'attached_toilet', rooms: 'bedrooms' },
  { type: 'zone', rooms: 'kitchen', zone: 'south-east' },
  { type: 'zone', rooms: 'pooja', zone: 'north-east' },
];

async function layOut(m: BuildingModel) {
  return runFixLoop(m, allRulesDecider, { objective: briefObjective, repairSteps: 4, maxSteps: 60, maxTries: 600 });
}

describe('lay out the rooms', () => {
  it('counts rooms in the brief', () => {
    const m = apply(shell(), 'set_brief', { items: layoutBrief(3, 3) });
    const res = checkBrief(m);
    expect(res[0]!.label).toBe('3 bedrooms');
    expect(res[0]!.met).toBe(false);
    expect(res[0]!.failing).toHaveLength(3);
  });

  for (const [bed, toilets, ew, ns] of [
    [3, 3, "60'", "40'"],
    [2, 2, "45'", "35'"],
    [3, 4, "60'", "40'"],
  ] as const) {
    it(`fills an empty shell: ${bed} bedrooms, ${toilets} toilets in ${ew} × ${ns}`, async () => {
      const m = apply(shell(ew, ns), 'set_brief', { items: layoutBrief(bed, toilets) });
      const r = await layOut(m);
      const res = checkBrief(r.model);
      const unmet = res.filter((x) => !x.met).map((x) => `${x.label}: ${x.failing.map((f) => f.why).join(', ')}`);
      console.log(`${bed}/${toilets}`, r.status, r.steps.filter((s) => s.accepted).map((s) => s.summary).join(' | '));
      expect(unmet).toEqual([]);
      expect(runChecks(r.model).filter((i) => i.severity === 'error')).toEqual([]);
      expect(r.model.rooms.filter((x) => x.kind === 'bedroom')).toHaveLength(bed);
      expect(r.model.rooms.filter((x) => x.kind === 'toilet').length).toBeGreaterThanOrEqual(toilets);
    }, 60000);
  }
});
