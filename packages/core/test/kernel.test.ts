import { describe, expect, it } from 'vitest';
import {
  applyOperation,
  commit,
  findEntities,
  operationToolDefinitions,
  parseOperation,
  redo,
  roomClearRect,
  runChecks,
  sampleModel,
  startHistory,
  undo,
  modelSummary,
  type BuildingModel,
  type Operation,
} from '../src';

const op = (name: string, args: unknown) => parseOperation(name, args);
const opening = (m: BuildingModel, id: string) => m.openings.find((o) => o.id === id)!;

describe('sample model', () => {
  it('starts clean: no errors or warnings', () => {
    const issues = runChecks(sampleModel()).filter((i) => i.severity !== 'advisory');
    expect(issues).toEqual([]);
  });
});

describe('move_opening', () => {
  it('moves a door along its wall and never mutates the input', () => {
    const m = sampleModel();
    const before = opening(m, 'd-bed2').offset;
    const r = applyOperation(m, op('move_opening', { openingId: 'd-bed2', direction: 'east', distance: '8 inches' }));
    expect(opening(r.model, 'd-bed2').offset).toBe(before + 203);
    expect(opening(m, 'd-bed2').offset).toBe(before);
    expect(r.model.revision).toBe(m.revision + 1);
    expect(r.summary).toBe('Moved Bed 2 door 8" east.');
    expect(r.assumptions.join(' ')).toMatch(/north arrow/);
  });

  it('refuses a direction across the wall and says why', () => {
    expect(() =>
      applyOperation(sampleModel(), op('move_opening', { openingId: 'd-bed2', direction: 'north', distance: '8"' })),
    ).toThrow(/running east–west, so it can't move north/);
  });

  it('resolves compass directions through the north arrow', () => {
    const m = { ...sampleModel(), northAngle: 90 }; // north points to plan-right
    const r = applyOperation(m, op('move_opening', { openingId: 'd-bed2', direction: 'north', distance: '1\'' }));
    expect(opening(r.model, 'd-bed2').offset).toBe(opening(m, 'd-bed2').offset + 305);
  });

  it('stops a door running past the end of its wall', () => {
    expect(() =>
      applyOperation(sampleModel(), op('move_opening', { openingId: 'd-bed1', direction: 'west', distance: "20'" })),
    ).toThrow(/past the end of its wall/);
  });

  it('records the bare-number unit assumption', () => {
    const r = applyOperation(sampleModel(), op('move_opening', { openingId: 'd-bed2', direction: 'east', distance: '1' }));
    expect(r.assumptions).toContain('"1" had no unit; assumed feet');
  });
});

describe('centre_opening', () => {
  it('centres a door on the room\'s clear span', () => {
    const r = applyOperation(sampleModel(), op('centre_opening', { openingId: 'd-bed2', roomId: 'r-bed2' }));
    const rect = roomClearRect(r.model, r.model.rooms.find((x) => x.id === 'r-bed2')!);
    expect(opening(r.model, 'd-bed2').offset).toBe(Math.round((rect.x0 + rect.x1) / 2));
  });
});

describe('move_wall ripple', () => {
  it('resizes rooms on both sides and stretches connected walls', () => {
    const m = sampleModel();
    const bed2 = (x: BuildingModel) => roomClearRect(x, x.rooms.find((r) => r.id === 'r-bed2')!);
    const t1 = (x: BuildingModel) => roomClearRect(x, x.rooms.find((r) => r.id === 'r-t1')!);
    const r = applyOperation(m, op('move_wall', { wallId: 'w-t-bed2', direction: 'east', distance: '8"' }));

    expect(bed2(r.model).x1 - bed2(r.model).x0).toBe(bed2(m).x1 - bed2(m).x0 - 203);
    expect(t1(r.model).x1 - t1(r.model).x0).toBe(t1(m).x1 - t1(m).x0 + 203);
    const tWall = r.model.walls.find((w) => w.id === 'w-t1-t2')!;
    expect(tWall.b.x).toBe(m.walls.find((w) => w.id === 'w-t1-t2')!.b.x + 203);
    expect(r.changedIds).toEqual(expect.arrayContaining(['w-t-bed2', 'w-t1-t2', 'r-bed2', 'r-t1', 'r-t2']));
    expect(r.changedIds).not.toContain('r-kitchen');
  });

  it('keeps doors on stretched walls in place', () => {
    const m = sampleModel();
    const r = applyOperation(m, op('move_wall', { wallId: 'w-mid', direction: 'north', distance: '6"' }));
    // Toilet 1 door sits on a wall whose bottom end stretched; it must not move.
    expect(opening(r.model, 'd-t1').offset).toBe(opening(m, 'd-t1').offset);
    expect(r.model.walls.find((w) => w.id === 'w-bed1-t')!.b.y).toBe(m.walls.find((w) => w.id === 'w-bed1-t')!.b.y - 152);
    // The full-height core wall passes through; it must not stretch.
    expect(r.model.walls.find((w) => w.id === 'w-core')).toEqual(m.walls.find((w) => w.id === 'w-core'));
  });

  it('explains when a wall cannot move in a direction', () => {
    expect(() =>
      applyOperation(sampleModel(), op('move_wall', { wallId: 'w-mid', direction: 'east', distance: '6"' })),
    ).toThrow(/can only move north or south/);
  });
});

describe('furniture', () => {
  it('places a handed sofa against a compass wall and flips it', () => {
    const r = applyOperation(
      sampleModel(),
      op('place_item', { catalogueId: 'sofa-3-chaise', roomId: 'r-living', against: 'west', hand: 'right' }),
    );
    const sofa = r.model.furniture.find((f) => f.catalogueId === 'sofa-3-chaise')!;
    expect(sofa.rotation).toBe(270);
    expect(sofa.mirrored).toBe(false);
    const flipped = applyOperation(r.model, op('flip_item', { itemId: sofa.id }));
    expect(flipped.model.furniture.find((f) => f.id === sofa.id)!.mirrored).toBe(true);
  });

  it('flags a wardrobe in the path of a door swing', () => {
    const r = applyOperation(
      sampleModel(),
      op('place_item', { catalogueId: 'wardrobe-3', roomId: 'r-bed2', against: 'south' }),
    );
    expect(runChecks(r.model).map((i) => i.code)).toContain('door.swing-blocked');
  });

  it('centres an item in its room', () => {
    const r = applyOperation(sampleModel(), op('centre_item', { itemId: 'f-dining', axis: 'north-south' }));
    const room = roomClearRect(r.model, r.model.rooms.find((x) => x.id === 'r-living')!);
    const f = r.model.furniture.find((x) => x.id === 'f-dining')!;
    expect(f.at.y).toBe(Math.round((room.y0 + room.y1) / 2));
    expect(f.at.x).toBe(sampleModel().furniture.find((x) => x.id === 'f-dining')!.at.x);
  });
});

describe('history', () => {
  it('one turn is one revision; undo and redo restore exactly', () => {
    const m = sampleModel();
    let h = startHistory(m);
    const ops: Operation[] = [
      op('move_opening', { openingId: 'd-bed2', direction: 'east', distance: '8"' }),
      op('move_opening', { openingId: 'd-bed3', direction: 'west', distance: '4"' }),
    ];
    let model = m;
    for (const o of ops) model = applyOperation(model, o).model;
    h = commit(h, { request: 'shift both doors', ops, summary: 'two moves', model });
    expect(h.past).toHaveLength(1);
    h = undo(h);
    expect(h.current.model).toEqual(m);
    h = redo(h);
    expect(h.current.model).toEqual(model);
  });
});

describe('agent surface', () => {
  it('exposes every operation as a JSON-schema tool', () => {
    const tools = operationToolDefinitions();
    const move = tools.find((t) => t.name === 'move_opening')!;
    expect(move.input_schema).toMatchObject({ type: 'object', required: ['openingId', 'direction', 'distance'] });
    expect(tools.length).toBeGreaterThanOrEqual(10);
  });

  it('rejects malformed tool input', () => {
    expect(() => parseOperation('move_opening', { openingId: 'd-bed2', direction: 'up', distance: '8"' })).toThrow();
    expect(() => parseOperation('teleport', {})).toThrow(/Unknown operation/);
  });

  it('resolves plain-language references', () => {
    const m = sampleModel();
    expect(findEntities(m, 'the Bed 2 door')[0]?.id).toBe('d-bed2');
    expect(findEntities(m, 'wall between Bed 2 and the kitchen')[0]?.id).toBe('w-bed2-kit');
    expect(findEntities(m, 'the dining table')[0]?.id).toBe('f-dining');
  });

  it('summarises the model compactly with compass sides', () => {
    const s = modelSummary(sampleModel());
    expect(s).toMatch(/north is up on the plan/);
    expect(s).toMatch(/r-bed2: Bed 2 \(bedroom\)/);
    expect(s.length).toBeLessThan(4000);
  });
});

describe('diffModels', () => {
  it('reports changed entities and room size deltas after a wall move', async () => {
    const { diffModels } = await import('../src');
    const a = sampleModel();
    const b = applyOperation(a, op('move_wall', { wallId: 'w-t-bed2', direction: 'east', distance: '8"' })).model;
    const d = diffModels(a, b);
    expect(d.changed).toEqual(expect.arrayContaining(['w-t-bed2', 'r-bed2', 'r-t1']));
    const bed2 = d.rooms.find((r) => r.id === 'r-bed2')!;
    expect(bed2.after!.w - bed2.before!.w).toBe(-203);
    expect(d.rooms.find((r) => r.id === 'r-kitchen')).toBeUndefined();
    expect(d.added).toEqual([]);
  });

  it('reports added furniture', async () => {
    const { diffModels } = await import('../src');
    const a = sampleModel();
    const b = applyOperation(a, op('place_item', { catalogueId: 'sofa-3', roomId: 'r-living', against: 'west' })).model;
    expect(diffModels(a, b).added).toHaveLength(1);
  });
});
