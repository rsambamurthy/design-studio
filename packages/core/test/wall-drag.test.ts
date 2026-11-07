import { describe, expect, it } from 'vitest';
import { applyOperation, coincidentSides, itemFootprint, parseOperation, planScheme, roomClearRect, SCHEMES, startDesign } from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);

describe('dragging a room wall', () => {
  it('resizes the rooms on both sides and fits the toilet out again inside its new walls', () => {
    const base = startDesign('shell', [op('set_plot', { eastWest: "50'", northSouth: "30'" }), op('set_setback', { side: 'all', distance: "0'" })], 'T').model;
    let m = applyOperation(base, op('apply_layout', planScheme(base, SCHEMES[1]!, { bedrooms: 3, toilets: 3, pooja: true, stores: 0 }))).model;
    const t = m.rooms.find((r) => r.name === 'Toilet 2')!;
    // The toilet wall shared with a bedroom.
    const side = (['left', 'right', 'top', 'bottom'] as const).find((sd) => coincidentSides(m, t, sd).some((p) => p.room.kind === 'bedroom'))!;
    const bed = coincidentSides(m, t, side).find((p) => p.room.kind === 'bedroom')!.room;
    const before = { t: roomClearRect(m, t), b: roomClearRect(m, bed) };
    const horizontal = side === 'left' || side === 'right';
    // Move the shared wall into the bedroom by 1'.
    const dir = side === 'right' ? 'east' : side === 'left' ? 'west' : side === 'top' ? 'north' : 'south';
    m = applyOperation(m, op('move_wall', { wallId: `blk:${t.id}:${side}`, direction: dir, distance: "1'" })).model;
    const after = { t: roomClearRect(m, m.rooms.find((r) => r.id === t.id)!), b: roomClearRect(m, m.rooms.find((r) => r.id === bed.id)!) };
    const size = (r: { x0: number; x1: number; y0: number; y1: number }) => (horizontal ? r.x1 - r.x0 : r.y1 - r.y0);
    expect(size(after.t) - size(before.t)).toBe(305);
    expect(size(before.b) - size(after.b)).toBe(305);
    const fx = m.furniture.filter((f) => f.roomId === t.id);
    expect(fx.some((f) => f.catalogueId === 'wc-floor')).toBe(true);
    for (const f of fx) {
      const q = itemFootprint(f);
      expect(q.x0 >= after.t.x0 - 2 && q.x1 <= after.t.x1 + 2 && q.y0 >= after.t.y0 - 2 && q.y1 <= after.t.y1 + 2, f.catalogueId).toBe(true);
    }
    // The shower still runs wall to wall in the wider toilet.
    const sh = fx.find((f) => f.catalogueId === 'shower');
    if (sh) {
      const q = itemFootprint(sh);
      expect([q.x0 - after.t.x0, after.t.x1 - q.x1, q.y0 - after.t.y0, after.t.y1 - q.y1].filter((g) => Math.abs(g) < 2).length).toBeGreaterThanOrEqual(3);
    }
  });
});
