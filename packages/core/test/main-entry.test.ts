import { describe, expect, it } from 'vitest';
import { applyOperation, checkBrief, layoutOptions, parseOperation, startDesign } from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);

describe('main entrance direction in the brief', () => {
  it('puts the main door on the side the owner chose', async () => {
    for (const [ew, ns] of [["35'", "52'6\""], ["60'", "40'"]]) {
      for (const facing of ['north', 'east', 'south', 'west'] as const) {
        let m = startDesign('shell', [op('set_plot', { eastWest: ew, northSouth: ns }), op('set_setback', { side: 'all', distance: "0'" })], 'T').model;
        m = applyOperation(m, op('set_brief', { items: [{ type: 'count', rooms: 'bedrooms', n: 3 }, { type: 'main_entry', rooms: 'house', facing }] })).model;
        const opts = await layoutOptions(m);
        expect(opts.length).toBe(3);
        for (const o of opts) expect(checkBrief(o.model).find((r) => r.item.type === 'main_entry')!.met, `${ew} ${facing} ${o.strategy.id}`).toBe(true);
      }
    }
  });

  it('reports the direction the main door actually faces', () => {
    let m = startDesign('shell', [op('set_plot', { eastWest: "40'", northSouth: "50'" })], 'T').model;
    m = applyOperation(m, op('set_brief', { items: [{ type: 'main_entry', rooms: 'house', facing: 'east' }] })).model;
    const r = checkBrief(m)[0]!;
    expect(r.label).toBe('Main entrance facing east');
    expect(r.met).toBe(false);
  });
});
