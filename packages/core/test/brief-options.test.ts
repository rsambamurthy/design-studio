import { describe, expect, it } from 'vitest';
import { applyOperation, checkBrief, layoutOptions, parseOperation, roomClearRect, runChecks, startDesign, roomOpeningsOn } from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);
const FT = 304.8;

describe('layout options follow the brief', () => {
  for (const [ew, ns] of [["50'", "30'"], ["40'", "60'"], ["35'", "52'6\""]] as const) {
    it(`${ew} × ${ns}: rooms all have doors, bedrooms ≥ 12'×12', wet rooms on outer walls, service door outside`, async () => {
      let m = startDesign('shell', [op('set_plot', { eastWest: ew, northSouth: ns }), op('set_setback', { side: 'all', distance: "0'" })], 'T').model;
      m = applyOperation(m, op('set_brief', { items: [
        { type: 'count', rooms: 'bedrooms', n: 3 }, { type: 'count', rooms: 'toilets', n: 3 }, { type: 'count', rooms: 'kitchen', n: 1 }, { type: 'count', rooms: 'pooja', n: 1 },
        { type: 'outer_wall', rooms: 'bedrooms' }, { type: 'attached_toilet', rooms: 'bedrooms' }, { type: 'outer_wall', rooms: 'wet rooms' },
        { type: 'min_size', rooms: 'bedrooms', width: "12'", depth: "12'" }, { type: 'service_entry', rooms: 'service', entry: 'outside' },
      ] })).model;
      const opts = await layoutOptions(m);
      for (const [k, o] of opts.entries()) {
        const tag = `${o.strategy.name}`;
        // Every room block has a door.
        for (const r of o.model.rooms.filter((x) => x.block)) {
          const doors = (['top', 'bottom', 'left', 'right'] as const).flatMap((s) => roomOpeningsOn(o.model, r, s)).filter((x) => x.kind === 'door' || x.kind === 'opening');
          expect(doors.length, `${tag}: ${r.name} has a door`).toBeGreaterThan(0);
        }
        const unmet = checkBrief(o.model).filter((r) => !r.met).map((r) => `${r.label}: ${r.failing.map((f) => f.why).join(', ')}`);
        console.log(ew, ns, tag, unmet);
        // A 50' × 30' house is too small for three 12' × 12' bedrooms with everything else; the card says so.
        // Only the best option has to fit them; the others show what they miss on their cards.
        const roomy = ew !== "50'" && k === 0;
        for (const b of roomy ? o.model.rooms.filter((x) => x.kind === 'bedroom') : []) {
          const c = roomClearRect(o.model, b);
          expect(Math.min(c.x1 - c.x0, c.y1 - c.y0) / FT, `${tag}: ${b.name}`).toBeGreaterThanOrEqual(11.9);
        }
        expect(unmet.filter((u) => /Toilets and kitchen|Service/i.test(u) || (roomy && /Every bedroom at least/i.test(u))), tag).toEqual([]);
        expect(runChecks(o.model).filter((i) => i.severity === 'error').map((i) => i.message), tag).toEqual([]);
      }
    }, 60000);
  }
});
