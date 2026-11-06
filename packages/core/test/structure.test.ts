import { describe, expect, it } from 'vitest';
import { generateStructure, getWall, layoutOptions, applyOperation, parseOperation, startDesign, MAX_SPAN, type BuildingModel } from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);
const tpl = (id: string) => startDesign(id, [op('set_plot', { eastWest: "40'", northSouth: "60'" }), op('set_setback', { side: 'all', distance: "5'" })], 'T').model;

function check(m: BuildingModel) {
  const s = generateStructure(m);
  console.log(`${s.columns.length} columns, ${s.beams.length} beams, ${s.slabs.length} slabs, grid ${s.gridX.length}×${s.gridY.length}, ${s.quantities.concreteM3} m³, ${s.quantities.steelKg} kg`, s.notes.map((n) => n.message));
  expect(s.columns.length).toBeGreaterThanOrEqual(4);
  // No beam longer than the max span (plus snapping slack).
  const openIds = new Set(s.notes.flatMap((n) => n.message.match(/^Beam (B\d+)/)?.slice(1) ?? []));
  for (const b of s.beams) expect(b.span).toBeLessThanOrEqual(openIds.has(b.id) ? 7500 : MAX_SPAN + 300);
  // No column inside a door or window.
  for (const o of m.openings) {
    const w = getWall(m, o.wallId);
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const d = { x: (w.b.x - w.a.x) / len, y: (w.b.y - w.a.y) / len };
    const c = { x: w.a.x + d.x * o.offset, y: w.a.y + d.y * o.offset };
    for (const col of s.columns) {
      const along = (col.x - c.x) * d.x + (col.y - c.y) * d.y;
      const across = Math.abs((col.x - c.x) * -d.y + (col.y - c.y) * d.x);
      if (across < 100) expect(Math.abs(along), `${col.id} in ${o.label}`).toBeGreaterThanOrEqual(o.width / 2);
    }
  }
  // Every column has a footing of at least 1.2 m.
  for (const c of s.columns) expect(c.footing).toBeGreaterThanOrEqual(1200);
  return s;
}

describe('preliminary structure', () => {
  it('frames the templates', () => {
    for (const id of ['3bhk', '2bhk']) check(tpl(id));
  });
  it('frames a laid-out shell', async () => {
    let m = tpl('shell');
    m = applyOperation(m, op('set_brief', { items: [{ type: 'count', rooms: 'bedrooms', n: 3 }, { type: 'count', rooms: 'toilets', n: 3 }, { type: 'count', rooms: 'kitchen', n: 1 }, { type: 'outer_wall', rooms: 'bedrooms' }, { type: 'attached_toilet', rooms: 'bedrooms' }] })).model;
    const [o] = await layoutOptions(m);
    const s = check(o!.model);
    expect(s.columns.some((c) => c.load > 0)).toBe(true);
  });
});

describe('structure edits and open spans', () => {
  const apply = (m: BuildingModel, n: string, a: unknown) => applyOperation(m, op(n, a)).model;
  it('adds beams across the open living space', () => {
    const s = generateStructure(tpl('3bhk'));
    const open = s.notes.filter((n) => /across open floor/.test(n.message));
    console.log(s.notes.map((n) => n.message));
    expect(open.length).toBeGreaterThan(0);
  });
  it('saves settings, moves and removes columns, and resets', () => {
    let m = tpl('3bhk');
    const s0 = generateStructure(m);
    m = apply(m, 'set_structure', { floors: 3, sbc: 100 });
    const s1 = generateStructure(m);
    expect(s1.settings.floors).toBe(3);
    expect(Math.max(...s1.columns.map((c) => c.footing))).toBeGreaterThan(Math.max(...s0.columns.map((c) => c.footing)));
    // Move a column on the top outer wall 600 mm along it.
    const c = [...s1.columns].sort((a, b) => a.y - b.y || a.x - b.x)[1]!;
    const r = applyOperation(m, op('set_structure', { moveColumn: { from: { x: c.x, y: c.y }, to: { x: c.x + 600, y: c.y + 200 } } }));
    expect(r.summary).toMatch(/moved column/);
    m = r.model;
    const s2 = generateStructure(m);
    const mv = s2.columns.find((x) => x.moved === 'Moved by you')!;
    expect(mv.y).toBe(c.y); // stays on the wall line
    expect(mv.x).toBe(c.x + 600);
    m = apply(m, 'set_structure', { removeColumn: { x: mv.x, y: mv.y } });
    expect(generateStructure(m).columns.length).toBe(s1.columns.length - 1);
    m = apply(m, 'set_structure', { resetColumns: true });
    expect(generateStructure(m).columns.length).toBe(s1.columns.length);
  });
});
