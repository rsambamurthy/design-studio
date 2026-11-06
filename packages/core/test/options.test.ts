import { describe, expect, it } from 'vitest';
import { applyOperation, checkBrief, layoutOptions, parseOperation, runChecks, startDesign, type BuildingModel } from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);
const apply = (m: BuildingModel, n: string, a: unknown) => applyOperation(m, op(n, a)).model;

describe('give me options', () => {
  it('lays out an empty shell three different ways, each replayable', async () => {
    let m = startDesign('shell', [op('set_plot', { eastWest: "60'", northSouth: "40'" }), op('set_setback', { side: 'all', distance: "5'" })], 'T').model;
    m = apply(m, 'set_brief', {
      items: [
        { type: 'count', rooms: 'bedrooms', n: 3 },
        { type: 'count', rooms: 'toilets', n: 3 },
        { type: 'count', rooms: 'kitchen', n: 1 },
        { type: 'count', rooms: 'pooja', n: 1 },
        { type: 'outer_wall', rooms: 'bedrooms' },
        { type: 'window', rooms: 'bedrooms' },
        { type: 'attached_toilet', rooms: 'bedrooms' },
        { type: 'zone', rooms: 'kitchen', zone: 'south-east' },
        { type: 'zone', rooms: 'pooja', zone: 'north-east' },
      ],
    });
    const opts = await layoutOptions(m);
    expect(opts).toHaveLength(3);
    const shapes = new Set<string>();
    for (const o of opts) {
      const unmet = checkBrief(o.model).filter((r) => !r.met).map((r) => r.label);
      console.log(o.strategy.name, o.status, unmet, Math.round(o.openArea / 92903), 'sq ft open');
      expect(unmet).toEqual([]);
      expect(runChecks(o.model).filter((i) => i.severity === 'error')).toEqual([]);
      // Replaying the ops on the start gives the same plan (how the app saves an option).
      let r = m;
      for (const x of o.ops) r = apply(r, x.op, x.args);
      expect(JSON.stringify(r.rooms)).toBe(JSON.stringify(o.model.rooms));
      shapes.add(JSON.stringify(o.model.rooms.filter((x) => x.kind === 'bedroom').map((x) => x.block)));
    }
    expect(shapes.size).toBe(3);
  }, 120000);
});
