import { describe, expect, it } from 'vitest';
import { applyOperation, layoutOptions, parseOperation, runChecks, startDesign, getWall, pointOnWall, type BuildingModel } from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);
const plot = [op('set_plot', { eastWest: "40'", northSouth: "60'" }), op('set_setback', { side: 'all', distance: "3'" })];

describe('entrance and floors', () => {
  it('every layout option is entered through the living area', async () => {
    let m = startDesign('shell', plot, 'T').model;
    m = applyOperation(m, op('set_brief', { items: [{ type: 'count', rooms: 'bedrooms', n: 3 }, { type: 'count', rooms: 'toilets', n: 3 }, { type: 'count', rooms: 'kitchen', n: 1 }] })).model;
    for (const o of await layoutOptions(m)) {
      const main = o.model.openings.find((x) => x.label === 'Main door');
      expect(main, o.strategy.name).toBeTruthy();
      expect(runChecks(o.model).filter((i) => i.code === 'entrance.into-room')).toEqual([]);
      // Just inside the main door is the open living area, not a room block.
      const w = getWall(o.model, main!.wallId);
      const p = pointOnWall(w, main!.offset);
      const inside = [-1, 1].map((d) => (Math.abs(w.a.y - w.b.y) < 1 ? { x: p.x, y: p.y + d * 500 } : { x: p.x + d * 500, y: p.y }));
      const hitsBlock = inside.some((q) => o.model.rooms.some((r) => r.block && q.x > r.block.x0 && q.x < r.block.x1 && q.y > r.block.y0 && q.y < r.block.y1));
      expect(hitsBlock, o.strategy.name).toBe(false);
    }
  });

  it('flags an outside door straight into a bedroom', () => {
    let m: BuildingModel = startDesign('shell', plot, 'T').model;
    m = applyOperation(m, op('add_room', { kind: 'bedroom', corner: 'south-west' })).model;
    const bed = m.rooms.find((r) => r.kind === 'bedroom')!;
    const ext = m.walls.find((w) => w.kind === 'external' && Math.abs(w.a.y - w.b.y) < 1 && Math.abs(w.a.y - bed.block!.y1) < 3)!;
    m = applyOperation(m, op('add_opening', { wallId: ext.id, kind: 'door', width: "3'", label: 'Side door', roomId: bed.id })).model;
    expect(runChecks(m).some((i) => i.code === 'entrance.into-room' && /Bed 1/.test(i.message))).toBe(true);
  });

  it('floors decide the stair; the lift is optional and only above one floor', () => {
    expect(startDesign('3bhk', plot, 'T', { floors: 1, lift: true }).model.cores ?? []).toEqual([]);
    const two = startDesign('3bhk', plot, 'T', { floors: 2 }).model;
    expect(two.cores!.map((c) => c.kind)).toEqual(['stair']);
    expect(two.structure?.floors).toBe(2);
    const lift = startDesign('3bhk', plot, 'T', { floors: 3, lift: true }).model;
    expect(lift.cores!.map((c) => c.kind).sort()).toEqual(['lift', 'stair']);
    // A lift added to a single-floor design is pointed out.
    let one = startDesign('shell', plot, 'T', { floors: 1 }).model;
    one = applyOperation(one, op('add_lift', { x: 3000, y: 3000 })).model;
    expect(runChecks(one).some((i) => i.code === 'core.lift-single-floor')).toBe(true);
  });

  it('laying out a G+1 house keeps its stair', async () => {
    let m = startDesign('shell', plot, 'T', { floors: 2 }).model;
    expect(m.cores!.map((c) => c.kind)).toEqual(['stair']);
    m = applyOperation(m, op('set_brief', { items: [{ type: 'count', rooms: 'bedrooms', n: 3 }] })).model;
    const [best] = await layoutOptions(m);
    expect(best!.model.cores!.map((c) => c.kind)).toEqual(['stair']);
    expect(runChecks(best!.model).filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([]);
  });
});
