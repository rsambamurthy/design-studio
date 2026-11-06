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
          const side = (['top', 'bottom', 'left', 'right'] as const).find((s) => roomOpeningsOn(m, t, s).some((o) => o.kind === 'window'));
          if (!side) continue;
          const win = roomOpeningsOn(m, t, side).find((o) => o.kind === 'window')!;
          const p = pointOnWall(getWall(m, win.wallId), win.offset);
          const r = roomClearRect(m, t);
          const fx = m.furniture.filter((f) => f.roomId === t.id);
          const wc = fx.find((f) => f.catalogueId === 'wc-floor')!;
          const h = side === 'top' || side === 'bottom';
          // WC against the window wall, centred on the window (unless the window is too close to a corner).
          expect(h ? Math.abs(wc.at.y - (side === 'top' ? r.y0 : r.y1)) : Math.abs(wc.at.x - (side === 'left' ? r.x0 : r.x1))).toBeLessThan(400);
          expect(Math.abs((h ? wc.at.x : wc.at.y) - (h ? p.x : p.y))).toBeLessThan(300);
          const shower = fx.find((f) => f.catalogueId === 'shower');
          if (shower) expect(h ? Math.abs(shower.at.y - (side === 'top' ? r.y1 : r.y0)) : Math.abs(shower.at.x - (side === 'left' ? r.x1 : r.x0))).toBeLessThan(500);
          const basin = fx.find((f) => f.catalogueId === 'wash-basin');
          if (basin) expect(Math.abs((h ? basin.at.y : basin.at.x) - (h ? (r.y0 + r.y1) / 2 : (r.x0 + r.x1) / 2))).toBeLessThan(50);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});
