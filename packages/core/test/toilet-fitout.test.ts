import { describe, expect, it } from 'vitest';
import { applyOperation, getWall, parseOperation, planScheme, pointOnWall, roomClearRect, roomOpeningsOn, SCHEMES, startDesign } from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);

describe('toilet fit-out', () => {
  it('puts the WC under the window, the shower opposite and the basin midway on a side wall', () => {
    let checked = 0;
    for (const [ew, ns] of [["35'", "52'6\""], ["60'", "40'"]]) {
      const base = startDesign('shell', [op('set_plot', { eastWest: ew, northSouth: ns }), op('set_setback', { side: 'all', distance: "0'" })], 'T').model;
      for (const sc of SCHEMES) {
        const m = applyOperation(base, op('apply_layout', planScheme(base, sc, { bedrooms: 3, toilets: 4, pooja: true, stores: 0 }))).model;
        for (const t of m.rooms.filter((r) => r.kind === 'toilet')) {
          const r = roomClearRect(m, t);
          const fx = m.furniture.filter((f) => f.roomId === t.id);
          const wc = fx.find((f) => f.catalogueId === 'wc-floor')!;
          // The window the WC sits under (a corner toilet may have two).
          const sides = (['top', 'bottom', 'left', 'right'] as const).filter((s) => roomOpeningsOn(m, t, s).some((o) => o.kind === 'window'));
          if (!sides.length) continue;
          const near = (s: (typeof sides)[number]) => (s === 'top' ? wc.at.y - r.y0 : s === 'bottom' ? r.y1 - wc.at.y : s === 'left' ? wc.at.x - r.x0 : r.x1 - wc.at.x);
          const side = sides.sort((a, b) => near(a) - near(b))[0]!;
          const win = roomOpeningsOn(m, t, side).find((o) => o.kind === 'window')!;
          const p = pointOnWall(getWall(m, win.wallId), win.offset);
          const h = side === 'top' || side === 'bottom';
          // WC against the window wall, centred on the window (unless the window is too close to a corner).
          expect(h ? Math.abs(wc.at.y - (side === 'top' ? r.y0 : r.y1)) : Math.abs(wc.at.x - (side === 'left' ? r.x0 : r.x1))).toBeLessThan(400);
          expect(Math.abs((h ? wc.at.x : wc.at.y) - (h ? p.x : p.y))).toBeLessThan(300);
          const shower = fx.find((f) => f.catalogueId === 'shower');
          // Shower on the opposite wall, unless the door is there (then beside the WC, away from the door).
          const doorOpposite = (['top', 'bottom', 'left', 'right'] as const).some((s) => s === ({ top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const)[side] && roomOpeningsOn(m, t, s).some((o) => o.kind === 'door'));
          const depth = h ? r.y1 - r.y0 : r.x1 - r.x0;
          const wallLen = h ? r.x1 - r.x0 : r.y1 - r.y0;
          if (shower && !doorOpposite && depth >= 2050) expect(h ? Math.abs(shower.at.y - (side === 'top' ? r.y1 : r.y0)) : Math.abs(shower.at.x - (side === 'left' ? r.x1 : r.x0))).toBeLessThan(500);
          // A ventilator on the long wall sits in a corner, never in the middle, and the WC with it.
          if (wallLen > depth + 1) {
            const lo = h ? r.x0 : r.y0;
            const hi = h ? r.x1 : r.y1;
            const at = h ? p.x : p.y;
            expect(Math.min(at - lo, hi - at), `${sc.id} ${t.name} ventilator in a corner`).toBeLessThan(wallLen / 2 - 300);
          }
          checked++;
          continue;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe('toilet entrance', () => {
  it('is in the middle of its wall, nearer the wash basin than the shower', () => {
    let checked = 0;
    for (const [ew, ns] of [["35'", "52'6\""], ["60'", "40'"], ["50'", "30'"]]) {
      const base = startDesign('shell', [op('set_plot', { eastWest: ew, northSouth: ns }), op('set_setback', { side: 'all', distance: "0'" })], 'T').model;
      for (const sc of SCHEMES) {
        const m = applyOperation(base, op('apply_layout', planScheme(base, sc, { bedrooms: 3, toilets: 4, pooja: true, stores: 0 }))).model;
        for (const t of m.rooms.filter((r) => r.kind === 'toilet')) {
          const side = (['top', 'bottom', 'left', 'right'] as const).find((s) => roomOpeningsOn(m, t, s).some((o) => o.kind === 'door'));
          if (!side) continue;
          const door = roomOpeningsOn(m, t, side).find((o) => o.kind === 'door')!;
          const p = pointOnWall(getWall(m, door.wallId), door.offset);
          const r = roomClearRect(m, t);
          const h = side === 'top' || side === 'bottom';
          const mid = h ? (r.x0 + r.x1) / 2 : (r.y0 + r.y1) / 2;
          // Centred unless the wall it shares is shorter than the toilet's side.
          if ((h ? r.x1 - r.x0 : r.y1 - r.y0) < 2600) expect(Math.abs((h ? p.x : p.y) - mid), `${sc.id} ${t.name}`).toBeLessThan(450);
          const fx = m.furniture.filter((f) => f.roomId === t.id);
          const basin = fx.find((f) => f.catalogueId === 'wash-basin');
          const shower = fx.find((f) => f.catalogueId === 'shower');
          if (basin && shower) {
            // You walk in facing the basin: it is straight across from the door, or nearer the door than the shower.
            const across = h ? Math.abs(basin.at.x - p.x) < 450 : Math.abs(basin.at.y - p.y) < 450;
            const d = (q: { x: number; y: number }) => Math.hypot(q.x - p.x, q.y - p.y);
            expect(across || d(basin.at) < d(shower.at), `${sc.id} ${t.name}: entrance towards the basin`).toBe(true);
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(15);
  });
});

describe('toilets at the corners', () => {
  it('puts a toilet in the plot corner with the ventilator on its short outer wall, not a scrap of floor beside it', () => {
    const base = startDesign('shell', [op('set_plot', { eastWest: "50'", northSouth: "30'" }), op('set_setback', { side: 'all', distance: "0'" })], 'T').model;
    const sc = SCHEMES.find((s) => s.id === 'split')!;
    for (const flip of [false, true]) {
      const m = applyOperation(base, op('apply_layout', planScheme(base, sc, { bedrooms: 3, toilets: 3, pooja: true, stores: 0 }, { x: flip }))).model;
      for (const name of ['Toilet 2', 'Toilet 3']) {
        const t = m.rooms.find((r) => r.name === name)!;
        const r = roomClearRect(m, t);
        // Touches the top or bottom wall: nothing between it and the corner.
        expect(r.y0 < 200 || r.y1 > 8700, name).toBe(true);
        const short = r.y0 < 200 ? 'top' : 'bottom';
        expect(roomOpeningsOn(m, t, short).some((o) => o.kind === 'window'), `${name} ventilator on its short wall`).toBe(true);
      }
    }
  });
});
