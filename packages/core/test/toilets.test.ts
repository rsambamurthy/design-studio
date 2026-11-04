import { describe, expect, it } from 'vitest';
import { applyOperation, hasAttachedToilet, parseOperation, runChecks, sampleModel, startDesign, type BuildingModel } from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);
const plot = (ew: string, ns: string, sb: string) => [op('set_plot', { eastWest: ew, northSouth: ns }), op('set_setback', { side: 'all', distance: sb })];
const count = (m: BuildingModel, kind: string) => m.rooms.filter((r) => r.kind === kind).length;
const errors = (m: BuildingModel) => runChecks(m).filter((i) => i.severity === 'error');

describe('toilets', () => {
  it('attaches a toilet to a bedroom along a wall without its door or window', () => {
    const m = sampleModel();
    const r = applyOperation(m, op('add_toilet', { roomId: 'r-bed3' }));
    const bed3 = r.model.rooms.find((x) => x.id === 'r-bed3')!;
    expect(count(r.model, 'toilet')).toBe(3);
    expect(hasAttachedToilet(r.model, bed3)).toBe(true);
    expect(r.summary).toMatch(/Added Toilet 3 attached to Bed 3/);
    expect(r.model.openings.some((o) => o.label === 'Toilet 3 ventilator')).toBe(true);
    expect(errors(r.model)).toEqual([]);
  });

  it('refuses when the room would be left too small', () => {
    expect(() => applyOperation(sampleModel(), op('add_toilet', { roomId: 'r-bed2' }))).toThrow(/no wall free/);
  });

  it('set_room_use turns a toilet into a store; its door label follows', () => {
    const r = applyOperation(sampleModel(), op('set_room_use', { roomId: 'r-t2', name: 'Store', kind: 'other' }));
    const t2 = r.model.rooms.find((x) => x.id === 'r-t2')!;
    expect(t2.kind).toBe('other');
    expect(t2.wet).toBe(false);
    expect(r.model.openings.find((o) => o.id === 'd-t2')!.label).toBe('Store door');
  });

  it('starts with the chosen bedrooms and toilets', () => {
    const three = startDesign('auto', plot("60'", "40'", "5'"), 'T', { bedrooms: 3, toilets: 3 }).model;
    expect(count(three, 'bedroom')).toBe(3);
    expect(count(three, 'toilet')).toBe(3);
    const four = startDesign('auto', plot("60'", "40'", "5'"), 'T', { bedrooms: 3, toilets: 4 });
    expect(count(four.model, 'toilet')).toBe(4);
    expect(four.notes.join(' ')).toMatch(/common toilet off Living/);
    const two = startDesign('auto', plot("60'", "40'", "5'"), 'T', { bedrooms: 2 }).model;
    expect(count(two, 'bedroom')).toBe(2);
    const one = startDesign('auto', plot("40'", "30'", "3'"), 'T', { bedrooms: 2, toilets: 1 }).model;
    expect(count(one, 'toilet')).toBe(1);
    expect(one.rooms.some((r) => r.name === 'Store')).toBe(true);
  });

  it('says how many toilets fit when too many are asked for', () => {
    expect(() => startDesign('auto', plot("30'", "30'", "3'"), 'T', { bedrooms: 1, toilets: 4 })).toThrow(/Only \d toilets? fits? this layout/);
  });
});

describe('toilet carving keeps other doors in place', () => {
  it('only the room\'s own covered door moves', () => {
    const before = startDesign('auto', [parseOperation('set_plot', { eastWest: "60'", northSouth: "40'" })], 'T', { bedrooms: 3 }).model;
    const after = startDesign('auto', [parseOperation('set_plot', { eastWest: "60'", northSouth: "40'" })], 'T', { bedrooms: 3, toilets: 4 }).model;
    for (const id of ['d-t2', 'd-bed2', 'd-bed1', 'd-kitchen']) {
      expect(after.openings.find((o) => o.id === id)!.offset).toBe(before.openings.find((o) => o.id === id)!.offset);
    }
    const moved = after.openings.find((o) => o.id === 'd-bed3')!;
    expect(moved.offset).not.toBe(before.openings.find((o) => o.id === 'd-bed3')!.offset);
  });
});
